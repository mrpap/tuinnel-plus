export interface SseFrame {
  event: string;
  data: string;
}

/** Incremental Server-Sent Events parser: feed it chunks, get complete frames back. */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseFrame[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const frames: SseFrame[] = [];
    let end: number;
    while ((end = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const i = line.indexOf(':');
        const field = i === -1 ? line : line.slice(0, i);
        const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) frames.push({ event, data: data.join('\n') });
    }
    return frames;
  }
}
