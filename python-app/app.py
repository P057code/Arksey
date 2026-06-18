from arksey import create_app


app = create_app()


if __name__ == "__main__":
    config = app.config["ARKSEY"]
    app.run(
        host="127.0.0.1",
        port=config.port,
        debug=config.debug,
    )
