import { blankCommentsAndStrings } from "./boundary-tracker.ts";
export interface MethodBehavioralSummary {
  analysis: "lexical_heuristic";
  guards: string[];
  hasTransaction: boolean;
  emittedEvents: string[];
  dispatchedJobs: string[];
  mutations: string[];
}

export class BehavioralAnalyzer {
  /**
   * Analyzes the body of a method or function to extract semantic side-effects,
   * authorization guards, database transactions, emitted events, and background job dispatches.
   */
  public static analyzeMethod(code: string): MethodBehavioralSummary {
    const guards = new Set<string>();
    let hasTransaction = false;
    const emittedEvents = new Set<string>();
    const dispatchedJobs = new Set<string>();
    const mutations = new Set<string>();

    const originalLines = code.split("\n");
    const lines = blankCommentsAndStrings(code, { hashComments: true }).split("\n");

    for (const [index, line] of lines.entries()) {
      const rawLine = originalLines[index]!;
      // Only recover literal arguments after the executable prefix matched the mask.
      const matchCode = (pattern: RegExp) => {
        const match = pattern.exec(line);
        return match ? pattern.exec(rawLine.slice(match.index)) : null;
      };
      if (!line || line.startsWith("//") || line.startsWith("#")) continue;

      // 1. Transaction Boundaries
      if (/(?:\bDB::(?:transaction|beginTransaction)|\bthis\.db\.transaction|\.transaction)\s*\(/.test(line)) {
        hasTransaction = true;
      }

      // 2. Authorization Guards
      // Laravel: $this->authorize('update', $order); or Gate::authorize(...)
      const authMatch = matchCode(/(?:\$this->authorize|Gate::authorize)\s*\(\s*['"]([^'"]+)['"]/);
      if (authMatch) {
        guards.add(authMatch[1]);
      }
      // Laravel: abort_if(!..., 403, '...');
      if (/\b(?:abort_if|abort_unless)\s*\(/.test(line)) {
        guards.add("abort_guard");
      }
      // TS / NestJS: @UseGuards(AuthGuard, RolesGuard)
      const guardDecoratorMatch = matchCode(/@UseGuards\s*\(([^)]+)\)/);
      if (guardDecoratorMatch) {
        const guardNames = guardDecoratorMatch[1].split(",").map((g) => g.trim());
        for (const g of guardNames) guards.add(g);
      }

      // 3. Emitted Events
      // Laravel: event(new OrderPlaced($order));
      const eventNewMatch = matchCode(/\bevent\s*\(\s*new\s+([A-Za-z0-9_]+)/);
      if (eventNewMatch) {
        emittedEvents.add(eventNewMatch[1]);
      }
      // Laravel: Event::dispatch(new OrderPlaced($order)); or Event::dispatch('name');
      const eventDispatchMatch = matchCode(/\bEvent::dispatch\s*\(\s*(?:new\s+)?([A-Za-z0-9_]+)/);
      if (eventDispatchMatch) {
        emittedEvents.add(eventDispatchMatch[1]);
      }
      // Laravel: broadcast(new OrderUpdated($order));
      const broadcastMatch = matchCode(/\bbroadcast\s*\(\s*new\s+([A-Za-z0-9_]+)/);
      if (broadcastMatch) {
        emittedEvents.add(broadcastMatch[1]);
      }
      // EventEmitter: this.eventEmitter.emit('order.created', ...)
      const nodeEmitMatch = matchCode(/(?:eventEmitter|\$emit)\.emit\s*\(\s*['"]([^'"]+)['"]/);
      if (nodeEmitMatch) {
        emittedEvents.add(nodeEmitMatch[1]);
      }

      // 4. Dispatched Background Jobs
      // Laravel: ProcessPaymentJob::dispatch($order); or ProcessPayment::dispatchSync(...)
      const jobDispatchStaticMatch = matchCode(/\b([A-Z][a-zA-Z0-9_]*(?:Job|Queue|Task|Process)[a-zA-Z0-9_]*)::dispatch/);
      if (jobDispatchStaticMatch) {
        dispatchedJobs.add(jobDispatchStaticMatch[1]);
      }
      // Laravel: dispatch(new ProcessPayment($order));
      const dispatchNewMatch = matchCode(/\bdispatch\s*\(\s*new\s+([A-Za-z0-9_]+)/);
      if (dispatchNewMatch) {
        dispatchedJobs.add(dispatchNewMatch[1]);
      }
      // BullMQ / Queue: queue.add('process-payment', ...)
      const queueAddMatch = matchCode(/(?:queue|queueService)\.add\s*\(\s*['"]([^'"]+)['"]/);
      if (queueAddMatch) {
        dispatchedJobs.add(queueAddMatch[1]);
      }

      // 5. Model Mutations
      // Laravel / ORM: $order->update([...]);
      const updateMatch = matchCode(/\$([a-zA-Z0-9_]+)->update\s*\(/);
      if (updateMatch) {
        mutations.add(`${updateMatch[1]}.update()`);
      }
      // Laravel / ORM: $order->delete();
      const deleteMatch = matchCode(/\$([a-zA-Z0-9_]+)->delete\s*\(/);
      if (deleteMatch) {
        mutations.add(`${deleteMatch[1]}.delete()`);
      }
      // Direct property assignment: $order->status = 'completed';
      const assignMatch = matchCode(/\$([a-zA-Z0-9_]+)->([a-zA-Z0-9_]+)\s*=(?![=>])\s*([^;]+);/);
      if (assignMatch && !["this", "request"].includes(assignMatch[1])) {
        mutations.add(`${assignMatch[1]}.${assignMatch[2]}`);
      }
    }

    return {
      analysis: "lexical_heuristic",
      guards: Array.from(guards),
      hasTransaction,
      emittedEvents: Array.from(emittedEvents),
      dispatchedJobs: Array.from(dispatchedJobs),
      mutations: Array.from(mutations),
    };
  }
}
