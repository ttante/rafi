// The fake notifier (SCN 7.5): records sends, updates and closes; answer() clicks a button.
import type { Cancel, NotificationRequest, Notifier } from "@rafi-ai/engine";

export type NotifierMode = "buttons" | "no-buttons" | "alerter-missing" | "alerter-broken" | "notify-send";

export interface SentNotification extends NotificationRequest {
  readonly id: string;
  readonly shown: string[];
  readonly more: boolean;
  readonly updates: string[];
  closed: boolean;
}

export class FakeNotifier implements Notifier {
  readonly sent: SentNotification[] = [];
  private readonly answerFns = new Set<(id: string, choice: string) => void>();

  constructor(readonly mode: NotifierMode = "buttons") {}

  async send(n: NotificationRequest) {
    if (this.mode === "alerter-missing") throw new Error("alerter: command not found");
    if (this.mode === "alerter-broken") throw new Error("alerter exited with code 1");
    const buttons = this.mode === "buttons" || this.mode === "notify-send";
    const shown = buttons ? n.choices.slice(0, 3) : [];
    const more = buttons && n.choices.length > 3;
    const record: SentNotification = { ...n, id: `n${this.sent.length + 1}`, shown, more, updates: [], closed: false };
    this.sent.push(record);
    return { id: record.id, shown, more };
  }

  async update(id: string, text: string) {
    this.find(id).updates.push(text);
  }

  async close(id: string) {
    this.find(id).closed = true;
  }

  onAnswer(fn: (id: string, choice: string) => void): Cancel {
    this.answerFns.add(fn);
    return () => this.answerFns.delete(fn);
  }

  /** Answers a notification as a user clicking a button. */
  answer(id: string, choice: string): void {
    for (const fn of this.answerFns) fn(id, choice);
  }

  private find(id: string): SentNotification {
    const found = this.sent.find((n) => n.id === id);
    if (!found) throw new Error(`no notification ${id}`);
    return found;
  }
}
