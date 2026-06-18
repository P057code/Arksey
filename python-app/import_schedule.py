from arksey.config import load_config
from arksey.schedule_importer import ScheduleImporter


if __name__ == "__main__":
    config = load_config(require_openrail=True)
    stats = ScheduleImporter(config).import_daily_schedule()
    print(stats)
