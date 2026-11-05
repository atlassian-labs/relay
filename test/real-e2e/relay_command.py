import os


def relay_command(root: str, agent: str) -> list[str]:
    return [
        "bun",
        "run",
        "--conditions=browser",
        os.path.join(root, "dist", "index.js"),
        "--agent",
        agent,
    ]
