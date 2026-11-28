import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { readAccountHome } from "../cli-launch.js";
import { userSettingsPath } from "../key-command-settings.js";
import { trustedDirectory } from "./job-path.js";
import { copyReceipt, remoteId, type CleanupCall, type CopyReceipt } from "../domain/engine-receipts.js";
import { ContractError } from "../domain/contract-error.js";

const saved = z.strictObject({receipt:copyReceipt, pid:z.int().positive().nullable(), host:z.string()});
type Saved = z.infer<typeof saved>;
export type ReadableReceipts = {readable:true; path:string; records:Saved[]};
type ReceiptScan = ReadableReceipts | {readable:false; path:string|null};
type Request = (path:string, init?: RequestInit) => Promise<Response>;
const startupRetryMs = 3000;
type RetryProgress = {signal:AbortSignal; confirmed:()=>void};
type Source = Pick<CopyReceipt,"recordingSha256"|"sentSha256"|"sentSpan">;

export function receiptDirectory() {
  if (process.platform === "win32") return join(userInfo().homedir,"AppData","Local","frameofmind","scratch-receipts");
  const settings = userSettingsPath(readAccountHome(), process.platform);
  if (!settings) throw new ContractError("CAPABILITY_MISSING","A private account directory is required for Twelve Labs scratch receipts.");
  return join(dirname(settings),"scratch-receipts");
}

async function privateDir(dir:string, create:boolean) {
  // Walk from the nearest existing ancestor so no component can redirect creation.
  let ancestor = dir;
  while (!await lstat(ancestor).catch(error=>{
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  })) ancestor = dirname(ancestor);
  trustedDirectory(ancestor);
  if (ancestor !== dir) {
    if (!create) return false;
    await mkdir(dir,{recursive:true,mode:0o700});
  }
  trustedDirectory(dir);
  const s = await lstat(dir);
  if (!s.isDirectory() || (process.geteuid && ((s.mode & 0o077) || (s.mode & 0o500) !== 0o500 || s.uid !== process.geteuid())) || await realpath(dir) !== dir)
    throw new ContractError("PERMISSION_DENIED","The scratch receipt directory must be private and owned by the current account.");
  return true;
}

async function pendingRecords(directory:string) {
  const found:Saved[] = [];
  for (const file of await readdir(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
    const handle = await open(join(directory,file),constants.O_NOFOLLOW | constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      const entry = await lstat(join(directory,file));
      if (!entry.isFile() || entry.dev !== info.dev || entry.ino !== info.ino) throw new Error("Unsafe receipt entry.");
      if (!info.isFile() || info.size > 16_384 || info.nlink !== 1 || (process.geteuid && (info.uid !== process.geteuid() || !(info.mode & 0o400) || (info.mode & 0o077)))) throw new Error("Unsafe receipt file.");
      const row = saved.parse(JSON.parse(await handle.readFile("utf8")));
      if (row.receipt.receiptId+".json" !== file) throw new Error("Mismatched receipt identity.");
      if (row.receipt.state !== "deleted") found.push(row);
    } finally { await handle.close(); }
  }
  return found;
}

export async function readScratchReceipts(directory?:string, create=false):Promise<ReceiptScan> {
  try {
    directory ??= receiptDirectory();
    const exists = await privateDir(directory,create);
    return {readable:true, path:directory, records:exists ? await pendingRecords(directory) : []};
  } catch {
    return {readable:false, path:directory ?? null};
  }
}

export class ScratchReceipts {
  readonly copies:CopyReceipt[] = [];
  readonly accountScope:string;
  private readonly directory:string;
  private readonly retryGroups:CopyReceipt[][];
  private readonly unresolved = new Set<string>();

  constructor(ledger:ReadableReceipts, key:string, private readonly runId:string, private readonly now:()=>string) {
    this.accountScope = createHash("sha256").update("twelvelabs account\0").update(key).digest("hex");
    this.directory = ledger.path;
    this.retryGroups = this.recoverable(ledger.records);
  }
  private async write(receipt:CopyReceipt, active:boolean, signal?:AbortSignal) {
    const path = join(this.directory,receipt.receiptId+".json");
    const tmp = join(this.directory,"."+randomUUID());
    try {
      const handle = await open(tmp,"wx",0o600);
      try {
        await handle.writeFile(JSON.stringify({receipt, pid:active ? process.pid : null, host:hostname()}));
        await handle.sync();
      } finally { await handle.close(); }
      signal?.throwIfAborted();
      await rename(tmp,path);
      if (process.platform !== "win32") {
        const parent = await open(this.directory,"r");
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await unlink(tmp).catch(()=>undefined); }
  }
  private recoverable(records:Saved[]) {
    const groups = new Map<string,Saved[]>();
    for (const row of records) {
      const receipt = row.receipt;
      if (receipt.accountScope !== this.accountScope) continue;
      if (receipt.state === "unconfirmed") this.unresolved.add(receipt.operation+"-"+receipt.sentSha256);
      const group = groups.get(receipt.runId) ?? [];
      group.push(row);
      groups.set(receipt.runId,group);
    }
    return [...groups.values()].filter(group=>!group.some(({pid,host}) => {
      if (host !== hostname()) return true;
      if (!pid) return false;
      try { process.kill(pid,0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
    })).map(group=>group.map(row=>row.receipt));
  }

  static async retryAtStart(
    resolveAccount:(signal:AbortSignal,remainingMs:()=>number)=>Promise<{catalog:ScratchReceipts;request:Request}|undefined>,
    tell:(message:string)=>Promise<void>, now:()=>string,
  ):Promise<CleanupCall|undefined> {
    const controller = new AbortController();
    const {signal} = controller;
    const deadline = performance.now()+startupRetryMs;
    const call:CleanupCall = {role:"cleanup",engine:"twelvelabs",model:null,material:"none",bytes:0,
      copies:0,sentExtent:null,inferenceWindow:null,utc:now(),state:"attempted",result:"failed"};
    let confirmed = 0;
    let contacted = false;
    const attempt = async () => {
      const account = await resolveAccount(signal,()=>Math.max(1,Math.ceil(deadline-performance.now())));
      signal.throwIfAborted();
      if (!account) return;
      const groups = account.catalog.retryGroups;
      call.copies = groups.flat().filter(r=>r.assetId || r.taskId).length;
      if (!call.copies) return;
      await tell(`Retrying deletion of ${call.copies} Twelve Labs scratch ${call.copies === 1 ? "copy" : "copies"}. No material is sent.`);
      const request:Request = (path,init) => {
        signal.throwIfAborted();
        contacted = true;
        return account.request(path,{...init,signal});
      };
      for (const group of groups) {
        await account.catalog.cleanup(group,request,{signal,confirmed:()=>{confirmed++;}});
      }
    };

    let timer:ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_,reject)=>{
      timer = setTimeout(()=>{ controller.abort(); reject(signal.reason); },startupRetryMs);
    });
    try {
      await Promise.race([attempt(),timeout]);
      if (!call.copies) return;
      if (confirmed !== call.copies) call.reason = "retry-unconfirmed";
    } catch {
      call.reason = signal.aborted ? "retry-timeout" : "retry-unavailable";
    } finally {
      clearTimeout(timer);
    }
    call.state = contacted ? (signal.aborted ? "unknown" : "sent") : "attempted";
    call.result = !call.reason ? "complete" : confirmed ? "partial" : "failed";
    return call;
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
  private async cleanup(copies:CopyReceipt[],request:Request,retry?:RetryProgress) {
    const tasks = copies.filter(r=>r.operation !== "upload");
    for (const receipt of [...tasks,...copies.filter(r=>r.operation === "upload")]) {
      retry?.signal.throwIfAborted();
      if (receipt.state === "deleted") continue;
      const path = receipt.operation === "upload" && receipt.assetId ? "/assets/"+receipt.assetId :
        receipt.operation !== "upload" && receipt.taskId ? "/analyze/tasks/"+receipt.taskId : undefined;
      const next = {...receipt};
      if (path) {
        try {
          next.reason = await this.remove(receipt,path,request,tasks);
          next.state = next.reason === null ? "deleted" : "pending";
        } catch { next.state = "pending"; next.reason = "unconfirmed-deletion"; }
      }
      retry?.signal.throwIfAborted();
      // A startup retry may only advance durable evidence after confirmed absence.
      if (retry && next.state !== "deleted") continue;
      next.checkedAt = this.now();
      if (next.state === "deleted") next.deletedAt = next.checkedAt;
      await this.write(next,false,retry?.signal);
      Object.assign(receipt,next);
      retry?.confirmed();
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
      const lists = [path+"/indexed-assets","/knowledge-stores?asset_id="+receipt.assetId,path+"/entities"];
      for (const list of lists) {
        try {
          const response = await request(list);
          if (!response.ok) return "link-check-unavailable";
          const page = await response.json();
          if (!Array.isArray(page.data) || !page.page_info) return "link-check-unavailable";
          const total = page.page_info.total_results;
          if (page.data.length || (Number.isSafeInteger(total) && total > 0)) return "linked";
          if (total !== 0 || page.page_info.page !== 1 || ![0,1].includes(page.page_info.total_page)) return "link-check-unavailable";
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
