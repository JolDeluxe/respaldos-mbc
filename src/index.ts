import { startService } from './service.js';

startService()
  .then((code) => {
    // Salida explícita para no depender de handles abiertos.
    setTimeout(() => process.exit(code), 200).unref();
  })
  .catch((err) => {
    console.error(`Error fatal al iniciar: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
