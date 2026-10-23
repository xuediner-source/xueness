/**
 * CPython 3.11 `ipaddress.ip_address`: parsing, `str()` and `is_global`, as
 * the Python network plugin applies them to DNS answers. Integers (bools
 * included) are accepted like Python; every other non-string is refused.
 */
import { JsonFloat } from "@xueness/contracts";

export interface IpAddress { version: 4 | 6; value: bigint; scope: string | null }

function octets(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255) return null;
    value = (value << 8n) | BigInt(part);
  }
  return value;
}

/** `IPv6Address._ip_int_from_string` after `_split_scope_id`. */
function hextets(text: string): bigint | null {
  if (!text) return null;
  const parts = text.split(":");
  if (parts.length < 3) return null;
  if (parts[parts.length - 1]!.includes(".")) {
    const tail = octets(parts.pop()!);
    if (tail === null) return null;
    parts.push(((tail >> 16n) & 0xffffn).toString(16), (tail & 0xffffn).toString(16));
  }
  if (parts.length > 9) return null;
  let skip = -1;
  for (let index = 1; index < parts.length - 1; index += 1) if (!parts[index]) { if (skip >= 0) return null; skip = index; }
  let hi: number, lo: number, skipped: number;
  if (skip >= 0) {
    hi = skip; lo = parts.length - skip - 1;
    if (!parts[0]) { hi -= 1; if (hi) return null; }
    if (!parts[parts.length - 1]) { lo -= 1; if (lo) return null; }
    skipped = 8 - (hi + lo);
    if (skipped < 1) return null;
  } else {
    if (parts.length !== 8 || !parts[0] || !parts[parts.length - 1]) return null;
    hi = parts.length; lo = 0; skipped = 0;
  }
  let value = 0n;
  const take = (group: string): boolean => { if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return false; value = (value << 16n) | BigInt("0x" + group); return true; };
  for (const group of parts.slice(0, hi)) if (!take(group)) return null;
  value <<= 16n * BigInt(skipped);
  for (const group of lo ? parts.slice(-lo) : []) if (!take(group)) return null;
  return value;
}

/** `ipaddress.ip_address(value)`, or null where Python raises ValueError. */
export function parseIp(value: unknown): IpAddress | null {
  if (value === true || value === false) value = value ? 1 : 0;
  if (typeof value === "number" && Number.isInteger(value)) value = BigInt(value);
  if (typeof value === "bigint") {
    if (value < 0n) return null;
    if (value < 1n << 32n) return { version: 4, value, scope: null };
    return value < 1n << 128n ? { version: 6, value, scope: null } : null;
  }
  if (typeof value !== "string" || value.includes("/")) return null;
  const v4 = octets(value);
  if (v4 !== null) return { version: 4, value: v4, scope: null };
  const percent = value.indexOf("%");
  let scope: string | null = null, address = value;
  if (percent >= 0) { scope = value.slice(percent + 1); if (!scope || scope.includes("%")) return null; address = value.slice(0, percent); }
  const v6 = hextets(address);
  return v6 === null ? null : { version: 6, value: v6, scope };
}

function v4Text(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".");
}

function v6Text(value: bigint): string {
  let groups = Array.from({ length: 8 }, (_, index) => ((value >> BigInt(112 - 16 * index)) & 0xffffn).toString(16));
  let bestStart = -1, bestLength = 0, start = -1, length = 0;
  groups.forEach((group, index) => {
    if (group === "0") { length += 1; if (start === -1) start = index; if (length > bestLength) { bestLength = length; bestStart = start; } }
    else { length = 0; start = -1; }
  });
  if (bestLength > 1) {
    const end = bestStart + bestLength;
    if (end === groups.length) groups.push("");
    groups.splice(bestStart, bestLength, "");
    if (bestStart === 0) groups = ["", ...groups];
  }
  return groups.join(":");
}

const mapped = (address: IpAddress): bigint | null => address.version === 6 && address.value >> 32n === 0xffffn ? address.value & 0xffffffffn : null;

/** `str(ip_address(value))`. */
export function ipText(address: IpAddress): string {
  if (address.version === 4) return v4Text(address.value);
  const v4 = mapped(address);
  const text = v4 === null ? v6Text(address.value) : "::ffff:" + v4Text(v4);
  return address.scope ? text + "%" + address.scope : text;
}

type Net = readonly [bigint, number];
const net4 = (text: string): Net => { const [a, b] = text.split("/"); return [octets(a!)!, Number(b)]; };
const net6 = (text: string): Net => { const [a, b] = text.split("/"); return [hextets(a!)!, Number(b)]; };
const V4_PRIVATE = ["0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.0.170/31", "192.0.2.0/24",
  "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "255.255.255.255/32"].map(net4);
const V4_EXCEPTIONS = ["192.0.0.9/32", "192.0.0.10/32"].map(net4);
const V4_SHARED = net4("100.64.0.0/10");
const V6_PRIVATE = ["::1/128", "::/128", "::ffff:0:0/96", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20", "fc00::/7", "fe80::/10"].map(net6);
const V6_EXCEPTIONS = ["2001:1::1/128", "2001:1::2/128", "2001:3::/32", "2001:4:112::/48", "2001:20::/28", "2001:30::/28"].map(net6);
const FAKE_IP = net4("198.18.0.0/15");

function within(value: bigint, bits: number, [network, prefix]: Net): boolean {
  const shift = BigInt(bits - prefix);
  return value >> shift === network >> shift;
}
const v4Private = (value: bigint): boolean => V4_PRIVATE.some((net) => within(value, 32, net)) && !V4_EXCEPTIONS.some((net) => within(value, 32, net));

/** `ip_address(value).is_global`. */
export function isGlobal(address: IpAddress): boolean {
  if (address.version === 4) return !within(address.value, 32, V4_SHARED) && !v4Private(address.value);
  const v4 = mapped(address);
  if (v4 !== null) return !within(v4, 32, V4_SHARED) && !v4Private(v4);
  return !(V6_PRIVATE.some((net) => within(address.value, 128, net)) && !V6_EXCEPTIONS.some((net) => within(address.value, 128, net)));
}

/** `transport._is_fakeip_only`: every answer is IPv4 in RFC 2544 198.18.0.0/15. */
export function fakeIpOnly(addresses: readonly string[]): boolean {
  if (!addresses.length) return false;
  return addresses.every((text) => { const address = parseIp(text); return !!address && address.version === 4 && within(address.value, 32, FAKE_IP); });
}

/** Python `==` against an int for a JSON value (bools and integral floats compare equal). */
export function equalsInt(value: unknown, target: number): boolean {
  if (typeof value === "boolean") return Number(value) === target;
  if (typeof value === "number") return value === target;
  if (typeof value === "bigint") return value === BigInt(target);
  return value instanceof JsonFloat && value.value === target;
}
