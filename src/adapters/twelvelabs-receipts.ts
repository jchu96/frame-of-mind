import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { readAccountHome } from "../cli-launch.js";
import { userSettingsPath } from "../key-command-settings.js";
import { trustedDirectory } from "./job-path.js";
import { copyReceipt, remoteId, type CopyReceipt } from "../domain/engine-receipts.js";
import { ContractError } from "../domain/contract-error.js";

const saved = z.strictObject({receipt:copyReceipt, pid:z.int().positive().nullable(), host:z.string()});
type Saved = z.infer<typeof saved>;
type Request = (path:string, init?: RequestInit) => Promise<Response>;
type Source = Pick<CopyReceipt,"recordingSha256"|"sentSha256"|"sentSpan">;

export function receiptDirectory() {
  if (process.platform === "win32") return join(userInfo().homedir,"AppData","Local","frameofmind","scratch-receipts");
  const settings = userSettingsPath(readAccountHome(), process.platform);
  if (!settings) throw new ContractError("CAPABILITY_MISSING","A private account directory is required for Twelve Labs scratch receipts.");
  return join(dirname(settings),"scratch-receipts");
}

async function privateDir(dir:string) {
  // Walk from the nearest existing ancestor so no component can redirect creation.
  let ancestor = dir;
  while (!await lstat(ancestor).catch(error=>{
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  })) ancestor = dirname(ancestor);
  trustedDirectory(ancestor);
  await mkdir(dir,{recursive:true,mode:0o700});
  trustedDirectory(dir);
  const s = await lstat(dir);
  if (!s.isDirectory() || (process.geteuid && ((s.mode & 0o077) || s.uid !== process.geteuid())) || await realpath(dir) !== dir)
    throw new ContractError("PERMISSION_DENIED","The scratch receipt directory must be private and owned by the current account.");
}

async function pendingRecords(directory:string) {
    await privateDir(directory);
    const found:Saved[] = [];
    for (const file of await readdir(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const handle = await open(join(directory,file),constants.O_NOFOLLOW | constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 16_384 || info.nlink !== 1 || (process.geteuid && (info.uid !== process.geteuid() || (info.mode & 0o077)))) throw new Error("Unsafe receipt file.");
        const row = saved.parse(JSON.parse(await handle.readFile("utf8")));
        if (row.receipt.receiptId+".json" !== file) throw new Error("Mismatched receipt identity.");
        if (row.receipt.state !== "deleted") found.push(row);
      } finally { await handle.close(); }
    }
    return found;
  }

export async function hasCleanupReceipts() {
  const dir = receiptDirectory();
  try {
    await lstat(dir);
    return (await pendingRecords(dir)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class ScratchReceipts {
  readonly copies:CopyReceipt[] = [];
  readonly accountScope:string;
  private unresolved = new Set<string>();
  constructor(private readonly directory:string, key:string, private readonly runId:string, private readonly now:()=>string) {
    this.accountScope = createHash("sha256").update("twelvelabs account\0").update(key).digest("hex");
  }
  private async write(receipt:CopyReceipt, active:boolean) {
    const path = join(this.directory,receipt.receiptId+".json");
    const tmp = join(this.directory,"."+randomUUID());
    try {
      const handle = await open(tmp,"wx",0o600);
      try {
        await handle.writeFile(JSON.stringify({receipt, pid:active ? process.pid : null, host:hostname()}));
        await handle.sync();
      } finally { await handle.close(); }
      await rename(tmp,path);
      if (process.platform !== "win32") {
        const parent = await open(this.directory,"r");
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await unlink(tmp).catch(()=>undefined); }
  }
  async recover(request:Request, tell:(message:string)=>Promise<void>) {
    const records = (await pendingRecords(this.directory)).filter(row=>row.receipt.accountScope === this.accountScope);
    const groups = new Map<string,Saved[]>();
    for (const row of records) {
      const group = groups.get(row.receipt.runId) ?? [];
      group.push(row); groups.set(row.receipt.runId,group);
    }
    for (const group of groups.values()) {
      for (const {receipt} of group) if (receipt.state === "unconfirmed") this.unresolved.add(receipt.operation+"-"+receipt.sentSha256);
      if (group.some(({pid,host}) => {
        if (host !== hostname()) return true;
        if (!pid) return false;
        try { process.kill(pid,0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
      })) continue;
      await tell("Checking Twelve Labs scratch deletion receipts (resource IDs only).");
      await this.cleanup(group.map(r=>r.receipt),request);
      for (const {receipt} of group) await tell("Twelve Labs scratch "+receipt.receiptId+" "+receipt.state+(receipt.reason ? " ("+receipt.reason+")" : "")+".");
    }
  }
  async intent(source:Source, operation:CopyReceipt["operation"]) {
    if (this.unresolved.has(operation+"-"+source.sentSha256))
      throw new ContractError("PROVIDER_UNREACHABLE","A previous scratch creation is unconfirmed.",{engine:"twelvelabs",phase:operation,reason:"network"});
    const time = this.now();
    const receipt:CopyReceipt = {...source,receiptId:randomUUID(),operationId:randomUUID(),runId:this.runId,engine:"twelvelabs",
      operation,accountScope:this.accountScope,owned:true,retention:"run",retentionSource:"default",
      createdAt:time,checkedAt:time,deletedAt:null,state:"unconfirmed",reason:"creation-unknown"};
    await this.write(receipt,true);
    this.copies.push(receipt);
    return receipt;
  }
  async refused(receipt:CopyReceipt) {
    receipt.state = "deleted";
    receipt.reason = "create-refused";
    receipt.checkedAt = receipt.deletedAt = this.now();
    await this.write(receipt,false);
  }
  async created(receipt:CopyReceipt, id:unknown) {
    const parsed = remoteId.safeParse(id);
    if (!parsed.success) throw new ContractError("PROVIDER_REFUSED","Invalid creation response.",{engine:"twelvelabs",phase:receipt.operation,reason:"invalid-reply"});
    if (receipt.operation === "upload") receipt.assetId = parsed.data;
    else receipt.taskId = parsed.data;
    receipt.state = "pending"; receipt.reason = "cleanup";
    await this.write(receipt,true);
    return parsed.data;
  }
  private async cleanup(copies:CopyReceipt[],request:Request) {
    const tasks = copies.filter(r=>r.operation !== "upload");
    for (const receipt of [...tasks,...copies.filter(r=>r.operation === "upload")]) {
      if (receipt.state === "deleted") continue;
      const path = receipt.operation === "upload" && receipt.assetId ? "/assets/"+receipt.assetId :
        receipt.operation !== "upload" && receipt.taskId ? "/analyze/tasks/"+receipt.taskId : undefined;
      if (path) {
        try {
          receipt.reason = await this.remove(receipt,path,request,tasks);
          receipt.state = receipt.reason === null ? "deleted" : "pending";
        } catch { receipt.state = "pending"; receipt.reason = "unconfirmed-deletion"; }
      }
      receipt.checkedAt = this.now();
      if (receipt.state === "deleted") receipt.deletedAt = receipt.checkedAt;
      await this.write(receipt,false);
    }
  }
  private async remove(receipt:CopyReceipt,path:string,request:Request,tasks:CopyReceipt[]):Promise<CopyReceipt["reason"]> {
    const identity = await request(path);
    if (identity.status === 404) return null;
    if (!identity.ok) return "identity-unconfirmed";
    const resource = await identity.json();
    const owned = receipt.assetId ? resource._id === receipt.assetId && resource.user_metadata?.operationId === receipt.operationId
      : resource.task_id === receipt.taskId && resource.custom_id === receipt.operationId;
    if (!owned) return "identity-unconfirmed";
    if (receipt.operation === "upload") {
      if (tasks.some(r=>r.state !== "deleted")) return "task-pending";
      for (const relation of ["indexed-assets","entities"]) {
        try {
          const response = await request(path+"/"+relation);
          if (!response.ok) return "link-check-unavailable";
          const page = await response.json();
          if (!Array.isArray(page.data) || !page.page_info) return "link-check-unavailable";
          const total = page.page_info.total_results;
          if (total !== undefined && (!Number.isSafeInteger(total) || total < 0)) return "link-check-unavailable";
          if (page.data.length || total > 0) return "linked";
          if (![0,1].includes(page.page_info.total_page)) return "link-check-unavailable";
        } catch { return "link-check-unavailable"; }
      }
    }
    const result = await request(path,{method:"DELETE"});
    if (result.status === 404) return null;
    if (!result.ok) return result.status === 409 ? receipt.assetId ? "linked" : "task-pending" : "delete-refused";
    return (await request(path)).status === 404 ? null : "unconfirmed-deletion";
  }
  async finish(request:Request) { await this.cleanup(this.copies, request); }
}
