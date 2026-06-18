import logging
import time

from arksey.config import load_config
from arksey.stomp_worker import StompWorker, start_daily_import_thread


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


if __name__ == "__main__":
    config = load_config(require_openrail=True)
    start_daily_import_thread(config)

    while True:
        try:
            StompWorker(config).run_forever()
        except KeyboardInterrupt:
            raise
        except Exception:
            logging.exception("STOMP worker stopped; reconnecting in 10 seconds")
            time.sleep(10)
