export async function retryTransaction(work, { wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), attempts = 3 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await work(); }
    catch (error) {
      const transient = Number(error.errCode) === -501001 || error.code === 'DATABASE_TRANSACTION_CONFLICT';
      if (!transient || attempt + 1 === attempts) throw error;
      await wait(60 * (attempt + 1) + Math.floor(Math.random() * 60));
    }
  }
}
