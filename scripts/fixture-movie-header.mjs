// Provider-transport fixtures never decode pictures. Give them an actual
// movie media header so whole-file timing can use the native tick offline.
export function fixtureMovieHeader() {
  function box(name, ...payload) {
    const header = Buffer.alloc(8);
    const contents = Buffer.concat(payload);
    header.writeUInt32BE(header.length + contents.length);
    header.write(name, 4, 4, "ascii");
    return Buffer.concat([header, contents]);
  }
  const handler = Buffer.alloc(24);
  handler.write("vide", 8);
  const media = Buffer.alloc(24);
  media.writeUInt32BE(1000, 12);
  media.writeUInt32BE(1000, 16);
  return box("moov", box("trak", box("mdia", box("mdhd", media), box("hdlr", handler))));
}
