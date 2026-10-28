/**
 * Minimal Prometheus text metrics: named counters/gauges with labels, rendered deterministically
 * (sorted by name then labels).
 */
export class Metrics {
  constructor() {
    /** @type {Map<string, number>} */
    this.values = new Map();
    /** @type {Map<string, string>} */
    this.help = new Map();
  }

  /** @param {string} name @param {string} help */
  describe(name, help) {
    this.help.set(name, help);
    return this;
  }

  /** @param {string} name @param {Record<string,string>} [labels] @param {number} [by] */
  inc(name, labels = {}, by = 1) {
    const key = seriesKey(name, labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
    return this;
  }

  /** @param {string} name @param {number} value @param {Record<string,string>} [labels] */
  set(name, value, labels = {}) {
    this.values.set(seriesKey(name, labels), value);
    return this;
  }

  /** Prometheus exposition format. */
  render() {
    const lines = [];
    const names = [...new Set([...this.values.keys()].map((k) => k.split('{')[0]))].sort();
    for (const name of names) {
      if (this.help.has(name)) lines.push(`# HELP ${name} ${this.help.get(name)}`);
      lines.push(`# TYPE ${name} ${name.endsWith('_total') ? 'counter' : 'gauge'}`);
      for (const key of [...this.values.keys()]
        .filter((k) => k === name || k.startsWith(`${name}{`))
        .sort())
        lines.push(`${key} ${this.values.get(key)}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

function seriesKey(name, labels) {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1));
  if (!entries.length) return name;
  const inner = entries
    .map(([k, v]) => `${k}="${String(v).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(',');
  return `${name}{${inner}}`;
}
