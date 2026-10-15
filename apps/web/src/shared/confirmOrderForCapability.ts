// Select once before dispatch. An ambiguous atomic response must never trigger
// the legacy write sequence: the database may already have committed it.
export async function confirmOrderForCapability<T>(
  atomicEnabled: boolean,
  actions: { legacy: () => Promise<T>; atomic: () => Promise<T> },
): Promise<T> {
  return atomicEnabled ? actions.atomic() : actions.legacy();
}
