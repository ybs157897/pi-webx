import { StringDecoder } from 'node:string_decoder';

/**
 * Strict JSONL record splitter for pi's RPC framing
 * (pi-coding-agent/docs/rpc.md -> "Framing").
 *
 * Rules implemented here, exactly:
 *  - LF (`\n`) is the only record delimiter.
 *  - A single trailing `\r` is stripped, so CRLF producers still work.
 *  - `U+2028` / `U+2029` are legal *inside* JSON strings and must never split a
 *    record. This is why `node:readline` cannot be used for RPC mode.
 *  - `StringDecoder` reassembles multibyte UTF-8 sequences that straddle chunk
 *    boundaries, so no record is corrupted by a partial code point.
 *
 * The splitter is deliberately dumb about content: it returns raw records and
 * never parses JSON. Blank records are returned as-is and filtered by the caller.
 */
export class JsonlSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';

  /** Feed one chunk (Buffer or string) and return every record it completed. */
  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    return this.drain(false);
  }

  /** Flush the decoder and return any residual record (call on stream end). */
  flush(): string[] {
    this.buffer += this.decoder.end();
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const records: string[] = [];

    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) break;
      records.push(stripTrailingCr(this.buffer.slice(0, newline)));
      this.buffer = this.buffer.slice(newline + 1);
    }

    if (final && this.buffer.length > 0) {
      records.push(stripTrailingCr(this.buffer));
      this.buffer = '';
    }

    return records;
  }
}

function stripTrailingCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}
