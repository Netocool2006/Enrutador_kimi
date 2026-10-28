import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'pathe';

export interface RouterLogRecord {
  readonly ts: string;
  readonly sessionId: string;
  readonly kind: 'turn' | 'subagent' | 'escalation';
  readonly action: string;
  readonly tier?: string;
  readonly model?: string;
  readonly previousModel?: string;
  readonly effort?: string;
  readonly reasons?: readonly string[];
  readonly simulated?: boolean;
  readonly detail?: string;
}

export const ROUTER_LOG_FILE = 'model-router.jsonl';
export const DEFAULT_ROUTER_LOG_MAX_BYTES = 5 * 1024 * 1024;

export class RouterLog {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxBytes: number,
  ) {}

  record(record: RouterLogRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    this.tail = this.tail.then(() => this.append(line), () => this.append(line));
  }

  flush(): Promise<unknown> {
    return this.tail;
  }

  private async append(line: string): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const size = await stat(this.filePath).then((s) => s.size, () => 0);
      if (size + line.length > this.maxBytes) {
        await rename(this.filePath, `${this.filePath}.1`).catch(() => undefined);
      }
      await appendFile(this.filePath, line, 'utf-8');
    } catch {}
  }
}

export function resolveRouterLogPath(sessionDir: string): string {
  return join(sessionDir, ROUTER_LOG_FILE);
}
