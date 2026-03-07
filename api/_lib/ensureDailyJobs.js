import { startSchedulers } from '../../src/services/scheduler.js';

let bootstrapPromise = null;

export async function ensureDailyJobsScheduled() {
  if (!bootstrapPromise) {
    bootstrapPromise = startSchedulers().catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  }

  return bootstrapPromise;
}
