from flask import Flask

from .config import load_config
from .web import web


def create_app():
    app = Flask(
        __name__,
        template_folder="../templates",
        static_folder="../static",
        static_url_path="/static",
    )
    app.config["ARKSEY"] = load_config()
    app.register_blueprint(web)
    return app
