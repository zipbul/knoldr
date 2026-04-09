const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Extract timestamp from ULID as epoch milliseconds */
export function decodeUlidTimestamp(id: string): number {
  let time = 0;
  for (let i = 0; i < 10; i++) {
    time = time * 32 + ENCODING.indexOf(id[i]!.toUpperCase());
  }
  return time;
}
