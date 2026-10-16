// Rupiah amount parsing and formatting.

/** Parse "50000", "50.000", "50rb", "50k", "1,5jt", "1.5 juta", "Rp 75.000". Returns null if invalid. */
export function parseAmount(input: string): { amount: number; rest: string } | null {
  const m = input.trim().match(/^(?:rp\.?\s*)?(\d+(?:[.,]\d+)*)\s*(rb|ribu|k|jt|juta|m)?\b\s*([\s\S]*)$/i);
  if (!m) return null;
  let num = m[1];
  const unit = (m[2] || "").toLowerCase();
  let value: number;
  if (unit) {
    // with a unit, "1,5" / "1.5" is a decimal; "1.500rb" style thousands is unusual, treat dots as thousands if 3 digits follow
    if (/^\d{1,3}([.,]\d{3})+$/.test(num) && !/[.,]\d{1,2}$/.test(num)) num = num.replace(/[.,]/g, "");
    else num = num.replace(",", ".");
    value = parseFloat(num) * (unit === "jt" || unit === "juta" ? 1e6 : unit === "m" ? 1e9 : 1e3);
  } else {
    // no unit: dots/commas are thousand separators ("50.000", "1,500,000")
    if (/^\d{1,3}([.,]\d{3})+$/.test(num)) num = num.replace(/[.,]/g, "");
    else if (/[.,]/.test(num)) return null;
    value = parseFloat(num);
  }
  value = Math.round(value);
  if (!isFinite(value) || value <= 0) return null;
  return { amount: value, rest: m[3].trim() };
}

export function rupiah(n: number): string {
  return (n < 0 ? "-" : "") + "Rp" + Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
