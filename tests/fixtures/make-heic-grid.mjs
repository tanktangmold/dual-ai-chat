// 2x2 网格 HEIC（和 iPhone 一样：4 个隐藏的 hvc1 小块 + 1 个 grid 主图，iref dimg 关联）
import { readFileSync, writeFileSync } from 'node:fs';
const [,, dir, out] = process.argv;
function find(buf, path, start = 0, end = buf.length) {
  let p = start;
  while (p + 8 <= end) {
    const size = buf.readUInt32BE(p); const type = buf.toString('latin1', p + 4, p + 8);
    if (type === path[0]) {
      if (path.length === 1) return { start: p, size, body: p + 8 };
      const skip = type === 'stsd' ? 8 : type === 'hvc1' ? 78 : 0;
      return find(buf, path.slice(1), p + 8 + skip, p + size);
    }
    p += size;
  }
  return null;
}
const tiles = [1, 2, 3, 4].map((n) => {
  const mp4 = readFileSync(`${dir}/tile${n}.mp4`);
  const h = find(mp4, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'hvc1', 'hvcC']); const m = find(mp4, ['mdat']);
  return { hvcC: mp4.subarray(h.start, h.start + h.size), data: mp4.subarray(m.body, m.start + m.size) };
});
const u8 = (n) => Buffer.from([n]); const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }; const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : p))); return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body]); };
const full = (type, v, flags, ...parts) => box(type, u8(v), u8((flags >> 16) & 255), u8((flags >> 8) & 255), u8(flags & 255), ...parts);
const gridData = Buffer.concat([u8(0), u8(0), u8(1), u8(1), u16(1440), u16(1000)]);
const payloads = [...tiles.map((t) => t.data), gridData];
const ftyp = box('ftyp', 'heic', u32(0), 'mif1', 'heic');
const build = (base) => {
  let off = base;
  const locs = payloads.map((p, i) => { const e = Buffer.concat([u16(i + 1), u16(0), u16(1), u32(off), u32(p.length)]); off += p.length; return e; });
  return full('meta', 0, 0,
    full('hdlr', 0, 0, u32(0), 'pict', u32(0), u32(0), u32(0), u8(0)),
    full('pitm', 0, 0, u16(5)),
    full('iloc', 0, 0, u8(0x44), u8(0x00), u16(5), ...locs),
    full('iinf', 0, 0, u16(5), ...[1, 2, 3, 4].map((id) => full('infe', 2, 1, u16(id), u16(0), 'hvc1', u8(0))), full('infe', 2, 0, u16(5), u16(0), 'grid', u8(0))),
    full('iref', 0, 0, box('dimg', u16(5), u16(4), u16(1), u16(2), u16(3), u16(4))),
    box('iprp',
      box('ipco', tiles[0].hvcC, full('ispe', 0, 0, u32(720), u32(500)), full('ispe', 0, 0, u32(1440), u32(1000))),
      full('ipma', 0, 0, u32(5), ...[1, 2, 3, 4].map((id) => Buffer.concat([u16(id), u8(2), u8(0x81), u8(0x02)])), Buffer.concat([u16(5), u8(1), u8(0x03)])))
  );
};
const metaLen = build(0).length;
const meta = build(ftyp.length + metaLen + 8);
writeFileSync(out, Buffer.concat([ftyp, meta, box('mdat', ...payloads)]));
console.log('grid heic written');
