"""Minimal, stateful ``az`` stub for the deploy/teardown PowerShell tests.

This module never talks to Azure. The tests point ``CLEARSIGHT_AZ_EXE`` at a
tiny PowerShell wrapper that forwards arguments to this script, so the real
deploy and teardown scripts exercise their full ``az`` call paths offline.

Environment:
    CLEARSIGHT_AZ_STUB_LOG       JSONL file with every invocation.
    CLEARSIGHT_AZ_STUB_STATE     JSON state persisted across invocations.
    CLEARSIGHT_AZ_STUB_SCENARIO  JSON scenario (subscription, failures, tags...).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

DEFAULT_SUB = "00000000-0000-0000-0000-000000000001"
DEFAULT_STATE = {"created": {}, "images": {}, "group_deleted": False, "jobs": {}}


def _load_json(path: str | None, default: object) -> object:
    if not path:
        return default
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def _save_json(path: str | None, data: object) -> None:
    if path:
        Path(path).write_text(json.dumps(data), encoding="utf-8")


scenario_path = os.environ.get("CLEARSIGHT_AZ_STUB_SCENARIO")
state_path = os.environ.get("CLEARSIGHT_AZ_STUB_STATE")
log_path = os.environ.get("CLEARSIGHT_AZ_STUB_LOG")

scenario = _load_json(scenario_path, {})
state = _load_json(state_path, json.loads(json.dumps(DEFAULT_STATE)))
for _key, _value in DEFAULT_STATE.items():
    state.setdefault(_key, json.loads(json.dumps(_value)))

args = sys.argv[1:]

if log_path:
    with open(log_path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"args": args}) + "\n")


def save_state() -> None:
    _save_json(state_path, state)


def fail(code: int = 1, message: str = "") -> None:
    if message:
        print(message, file=sys.stderr)
    sys.exit(code)


def emit(value: object, output_format: str | None) -> None:
    if output_format == "json" or isinstance(value, dict | list):
        sys.stdout.write(json.dumps(value) + "\n")
    elif isinstance(value, bool):
        sys.stdout.write("true\n" if value else "false\n")
    elif value is None:
        sys.stdout.write("\n")
    else:
        sys.stdout.write(str(value) + "\n")


def opt(*names: str) -> str | None:
    for name in names:
        if name in args:
            index = args.index(name)
            if index + 1 < len(args):
                return args[index + 1]
    return None


def joined() -> str:
    return " ".join(args)


def output_format() -> str | None:
    return opt("--output") or opt("-o")


def parse_tags() -> dict[str, str]:
    if "--tags" not in args:
        return {}
    index = args.index("--tags") + 1
    tags: dict[str, str] = {}
    while index < len(args):
        token = args[index]
        if token.startswith("-"):
            break
        if "=" in token:
            key, value = token.split("=", 1)
            tags[key] = value
        index += 1
    return tags


def subscription_id() -> str:
    return str(scenario.get("subscription_id", DEFAULT_SUB))


def resource_group() -> str:
    return opt("--resource-group") or "clearsight-run123"


def make_id(kind: str, name: str) -> str:
    base = f"/subscriptions/{subscription_id()}/resourceGroups/{resource_group()}"
    if kind == "group":
        return base
    mapping = {
        "storage": f"Microsoft.Storage/storageAccounts/{name}",
        "acr": f"Microsoft.ContainerRegistry/registries/{name}",
        "postgres": f"Microsoft.DBforPostgreSQL/flexibleServers/{name}",
        "redis": f"Microsoft.Cache/Redis/{name}",
        "env": f"Microsoft.App/managedEnvironments/{name}",
        "containerapp": f"Microsoft.App/containerApps/{name}",
        "job": f"Microsoft.App/jobs/{name}",
    }
    suffix = mapping.get(kind)
    if suffix is None:
        container_path = (
            f"Microsoft.Storage/storageAccounts/{name}"
            f"/blobServices/default/containers/{name}"
        )
        return f"{base}/providers/{container_path}"
    return f"{base}/providers/{suffix}"


def state_key(kind: str, name: str) -> str:
    return f"{kind}:{name}"


def record(kind: str, name: str) -> None:
    if kind == "container":
        parent = opt("--account-name") or "storage"
        identifier = make_id("storage", parent) + f"/blobServices/default/containers/{name}"
    else:
        identifier = make_id(kind, name)
    tags = parse_tags()
    existing = state["created"].get(state_key(kind, name))
    if not tags and isinstance(existing, dict):
        prior = existing.get("tags", {})
        if isinstance(prior, dict):
            tags = prior
    state["created"][state_key(kind, name)] = {
        "kind": kind,
        "name": name,
        "tags": tags,
        "id": identifier,
        "group": name if kind == "group" else resource_group(),
    }
    save_state()


def find(kind: str, name: str | None) -> dict[str, object] | None:
    if not name:
        return None
    if state.get("group_deleted") and kind != "group":
        return None
    entry = state["created"].get(state_key(kind, name))
    return entry if isinstance(entry, dict) else None


def is_pre_existing(name: str | None) -> bool:
    if not name:
        return False
    tokens = scenario.get("pre_existing", [])
    return name in tokens


def exists(kind: str, name: str | None) -> bool:
    if find(kind, name) is not None:
        return True
    return is_pre_existing(name)


def tags_for(kind: str, name: str) -> dict[str, object]:
    entry = find(kind, name)
    if entry is not None:
        tags = entry.get("tags", {})
        return tags if isinstance(tags, dict) else {}
    scenario_tags = scenario.get("existing_tags", {})
    if name in scenario_tags:
        return scenario_tags[name]
    return scenario.get("default_existing_tags", {})


def query_value(kind: str, name: str, query: str | None) -> object:
    entry = find(kind, name)
    identifier = entry["id"] if entry is not None else make_id(kind, name)
    if query in (None, "", "id"):
        return identifier
    if query == "tags":
        return tags_for(kind, name)
    if kind == "acr" and query == "loginServer":
        return f"{name}.azurecr.io"
    if kind == "acr" and query == "username":
        return scenario.get("acr_username", f"{name}-admin")
    if kind == "postgres" and query == "fullyQualifiedDomainName":
        return f"{name}.postgres.database.azure.com"
    if kind == "redis" and query == "hostName":
        return f"{name}.redis.cache.windows.net"
    if kind == "containerapp" and query == "properties.configuration.ingress.fqdn":
        env_name = scenario.get("env_name", "clearsight-env")
        return f"{name}.{env_name}.azurecontainerapps.io"
    if kind == "env" and query == "defaultDomain":
        return f"{name}.azurecontainerapps.io"
    return None


def handle_show(kind: str, name: str | None) -> None:
    if not exists(kind, name):
        fail(3)
    assert name is not None
    emit(query_value(kind, name, opt("--query")), output_format())
    sys.exit(0)


def handle_delete(kind: str, name: str | None) -> None:
    if name and state_key(kind, name) in state["created"]:
        del state["created"][state_key(kind, name)]
        save_state()
    sys.exit(0)


# Forced failures used by the gate and cleanup tests.
for pattern in scenario.get("fail_commands", []):
    if pattern in joined():
        fail(int(scenario.get("fail_exit", 1)), f"forced failure: {pattern}")


# account -------------------------------------------------------------------
if args[:2] == ["account", "show"]:
    query = opt("--query")
    if query == "id":
        emit(subscription_id(), output_format())
    elif query == "name":
        emit(scenario.get("subscription_name", "stub-subscription"), output_format())
    elif query == "state":
        emit(scenario.get("state", "Enabled"), output_format())
    else:
        emit(
            {
                "id": subscription_id(),
                "name": scenario.get("subscription_name", "stub-subscription"),
                "state": scenario.get("state", "Enabled"),
            },
            output_format(),
        )
    sys.exit(0)


# provider ------------------------------------------------------------------
if args[:2] == ["provider", "show"]:
    namespace = opt("--namespace") or ""
    registration = scenario.get("providers", {}).get(namespace, "Registered")
    if opt("--query") == "registrationState":
        emit(registration, output_format())
    else:
        emit({"namespace": namespace, "registrationState": registration}, output_format())
    sys.exit(0)


# resource group ------------------------------------------------------------
if args[:2] == ["group", "show"]:
    handle_show("group", opt("--name"))
if args[:2] == ["group", "exists"]:
    name = opt("--name")
    present = exists("group", name) and not (
        state.get("group_deleted") and not scenario.get("group_delete_ignored")
    )
    emit(bool(present), output_format())
    sys.exit(0)
if args[:2] == ["group", "create"]:
    record("group", opt("--name") or "")
    sys.exit(0)
if args[:2] == ["group", "delete"]:
    name = opt("--name") or ""
    if not scenario.get("group_delete_ignored"):
        state["group_deleted"] = True
        state["created"].pop(state_key("group", name), None)
    save_state()
    sys.exit(0)


# storage -------------------------------------------------------------------
if args[:3] == ["storage", "account", "show"]:
    handle_show("storage", opt("--name"))
if args[:3] == ["storage", "account", "create"]:
    record("storage", opt("--name") or "")
    sys.exit(0)
if args[:3] == ["storage", "account", "delete"]:
    handle_delete("storage", opt("--name"))
if args[:4] == ["storage", "account", "keys", "list"]:
    canary = scenario.get("canary_storage_key", "CANARY-STORAGE-KEY")
    if opt("--query") == "[0].value":
        emit(canary, output_format())
    else:
        emit([{"value": canary}], output_format())
    sys.exit(0)
if args[:3] == ["storage", "container", "create"]:
    record("container", opt("--name") or "")
    sys.exit(0)
if args[:3] == ["storage", "container", "list"]:
    emit(scenario.get("deleted_containers", []), "json")
    sys.exit(0)
if args[:3] == ["storage", "blob", "upload"]:
    sys.exit(0)


# container registry --------------------------------------------------------
if args[:2] == ["acr", "show"]:
    handle_show("acr", opt("--name"))
if args[:2] == ["acr", "create"]:
    record("acr", opt("--name") or "")
    sys.exit(0)
if args[:2] == ["acr", "update"]:
    record("acr", opt("--name") or "")
    sys.exit(0)
if args[:2] == ["acr", "delete"]:
    handle_delete("acr", opt("--name"))
if args[:2] == ["acr", "build"]:
    image = opt("--image") or ""
    digest = scenario.get("digests", {}).get(
        image, "sha256:" + hashlib.sha256(image.encode("utf-8")).hexdigest()
    )
    state["images"][image] = digest
    save_state()
    sys.exit(0)
if args[:2] == ["acr", "credential"]:
    username = scenario.get("acr_username", "clearsightacr-admin")
    password = scenario.get("canary_acr_password", "CANARY-ACR-PASSWORD")
    query = opt("--query")
    if query == "username":
        emit(username, output_format())
    elif query == "passwords[0].value":
        emit(password, output_format())
    else:
        emit({"username": username, "passwords": [{"value": password}]}, output_format())
    sys.exit(0)
if args[:3] == ["acr", "repository", "show"]:
    image = opt("--image") or ""
    digest = state["images"].get(image) or scenario.get("digests", {}).get(
        image, "sha256:" + hashlib.sha256(image.encode("utf-8")).hexdigest()
    )
    emit(digest, output_format())
    sys.exit(0)
if args[:3] == ["acr", "repository", "list"]:
    emit(scenario.get("acr_repositories", []), "json")
    sys.exit(0)


# postgres ------------------------------------------------------------------
if args[:3] == ["postgres", "flexible-server", "show"]:
    handle_show("postgres", opt("--name"))
if args[:3] == ["postgres", "flexible-server", "create"]:
    record("postgres", opt("--name") or "")
    sys.exit(0)
if args[:3] == ["postgres", "flexible-server", "delete"]:
    handle_delete("postgres", opt("--name"))
if args[:4] == ["postgres", "flexible-server", "db", "show"]:
    fail(3)
if args[:4] == ["postgres", "flexible-server", "db", "create"]:
    sys.exit(0)
if args[:4] == ["postgres", "flexible-server", "firewall-rule", "show"]:
    fail(3)
if args[:4] == ["postgres", "flexible-server", "firewall-rule", "create"]:
    sys.exit(0)


# redis ---------------------------------------------------------------------
if args[:2] == ["redis", "show"]:
    handle_show("redis", opt("--name"))
if args[:2] == ["redis", "create"]:
    record("redis", opt("--name") or "")
    sys.exit(0)
if args[:2] == ["redis", "delete"]:
    handle_delete("redis", opt("--name"))
if args[:2] == ["redis", "list-keys"]:
    key = scenario.get("canary_redis_key", "CANARY-REDIS-KEY")
    if opt("--query") == "primaryKey":
        emit(key, output_format())
    else:
        emit({"primaryKey": key}, output_format())
    sys.exit(0)


# container apps ------------------------------------------------------------
if args[:3] == ["containerapp", "env", "show"]:
    handle_show("env", opt("--name"))
if args[:3] == ["containerapp", "env", "create"]:
    record("env", opt("--name") or "")
    sys.exit(0)
if args[:3] == ["containerapp", "env", "delete"]:
    handle_delete("env", opt("--name"))

if args[:3] == ["containerapp", "job", "show"]:
    handle_show("job", opt("--name"))
if args[:3] == ["containerapp", "job", "create"]:
    record("job", opt("--name") or "")
    sys.exit(0)
if args[:3] == ["containerapp", "job", "delete"]:
    handle_delete("job", opt("--name"))
if args[:3] == ["containerapp", "job", "start"]:
    name = opt("--name") or ""
    state.setdefault("jobs", {})[name] = "Succeeded"
    save_state()
    sys.exit(0)
if args[:4] == ["containerapp", "job", "execution", "list"]:
    emit(scenario.get("job_status", "Succeeded"), output_format())
    sys.exit(0)

if args[:2] == ["containerapp", "show"]:
    handle_show("containerapp", opt("--name"))
if args[:2] == ["containerapp", "create"]:
    record("containerapp", opt("--name") or "")
    sys.exit(0)
if args[:2] == ["containerapp", "update"]:
    record("containerapp", opt("--name") or "")
    sys.exit(0)
if args[:2] == ["containerapp", "delete"]:
    handle_delete("containerapp", opt("--name"))


# generic resource queries --------------------------------------------------
if args[:2] == ["resource", "show"]:
    identifier = opt("--ids")
    if not identifier:
        fail(3)
    found: dict[str, object] | None = None
    for entry in state["created"].values():
        if isinstance(entry, dict) and entry.get("id") == identifier:
            found = entry
            break
    id_tags = scenario.get("id_tags", {})
    if found is None and identifier in id_tags:
        found = {"tags": id_tags[identifier], "id": identifier}
    if found is None and scenario.get("resource_exists"):
        found = {"tags": scenario.get("default_existing_tags", {}), "id": identifier}
    if found is None:
        fail(3)
    if opt("--query") == "tags":
        emit(found.get("tags", {}), "json")
    else:
        emit(found, output_format())
    sys.exit(0)

if args[:2] == ["resource", "list"]:
    items = scenario.get("residual_resources", [])
    if opt("--resource-type") == "Microsoft.Network/publicIPAddresses":
        items = scenario.get("residual_ips", [])
    emit(items, "json")
    sys.exit(0)


# Unknown command: succeed without output so the script keeps its own logic.
sys.exit(0)
