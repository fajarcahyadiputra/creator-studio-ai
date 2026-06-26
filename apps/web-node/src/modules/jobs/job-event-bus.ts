import { EventEmitter } from "node:events";
import type { RedisClient } from "../../infrastructure/redis/client.js";

export class JobEventBus {
  readonly #emitter = new EventEmitter();
  readonly #publisher: RedisClient;
  readonly #subscriber: RedisClient;

  public constructor(redis: RedisClient) {
    this.#publisher = redis;
    this.#subscriber = redis.duplicate();
    this.#emitter.setMaxListeners(0);
  }

  public async start(): Promise<void> {
    await this.#subscriber.connect();
    await this.#subscriber.pSubscribe("job:*", (message, channel) => {
      this.#emitter.emit(channel, message);
    });
  }

  public async publish(jobId: string, sequence: bigint): Promise<void> {
    await this.#publisher.publish(`job:${jobId}`, sequence.toString());
  }

  public on(jobId: string, listener: () => void): () => void {
    const channel = `job:${jobId}`;
    this.#emitter.on(channel, listener);
    return () => this.#emitter.off(channel, listener);
  }

  public async close(): Promise<void> {
    await this.#subscriber.quit();
  }
}
