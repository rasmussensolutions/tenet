/** Prefer a globally routable interface address; never present private addresses as public. */
export function primaryAddress(addresses: string[] = []): string | undefined {
  const ipv4 = addresses.find((ip) => {
    if (ip.includes(":")) return false;
    const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  });
  return (
    ipv4 ??
    addresses.find(
      (ip) =>
        /^[23][0-9a-f]{3}:/i.test(ip) &&
        !/^2001:(db8|0|2|10|20):/i.test(ip) &&
        !/^2002:/i.test(ip),
    )
  );
}
