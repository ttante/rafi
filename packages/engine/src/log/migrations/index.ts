// Ordered migrations. user_version holds the last one applied. No down-migrations, no triggers (ARCH 3.5).
import * as initial from "./001-initial.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const migrations: readonly Migration[] = Object.freeze([
  Object.freeze({ version: 1, name: initial.name, sql: initial.sql }),
]);

export const latestVersion = migrations.length;
