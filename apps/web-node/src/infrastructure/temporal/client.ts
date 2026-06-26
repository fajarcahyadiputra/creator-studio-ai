import { Client, Connection } from "@temporalio/client";
import { env } from "../../config/env.js";

let connection: Connection | undefined;
let client: Client | undefined;

export async function temporalClient(): Promise<Client> {
  if (client) return client;
  connection = await Connection.connect({ address: env.TEMPORAL_ADDRESS });
  client = new Client({ connection, namespace: env.TEMPORAL_NAMESPACE });
  return client;
}

export async function closeTemporalClient(): Promise<void> {
  await connection?.close();
  client = undefined;
  connection = undefined;
}
