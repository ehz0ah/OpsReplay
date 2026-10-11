/** Remove only OSC 133 shell metadata from browser output. Raw recording bytes
 * stay unchanged. Keep at most the six-byte prefix across output deliveries. */
export class ShellMarkerFilter {
  private prefix: number[] = [];
  private discard = false;
  private escaped = false;
  private readonly target = [0x1b, 0x5d, 0x31, 0x33, 0x33, 0x3b];
  write(bytes: Buffer): Buffer {
    const output: number[] = [];
    for (const byte of bytes) {
      if (this.discard) {
        if (byte === 7 || (this.escaped && byte === 0x5c)) {
          this.discard = false;
          this.escaped = false;
        } else this.escaped = byte === 0x1b;
        continue;
      }
      if (byte === this.target[this.prefix.length]) {
        this.prefix.push(byte);
        if (this.prefix.length === this.target.length) {
          this.discard = true;
          this.prefix = [];
        }
        continue;
      }
      output.push(...this.prefix);
      this.prefix = [];
      if (byte === 0x1b) this.prefix.push(byte);
      else output.push(byte);
    }
    return Buffer.from(output);
  }
}
