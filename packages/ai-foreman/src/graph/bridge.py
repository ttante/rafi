"""Pinned Graphify adapter. One bounded JSON request on stdin, one JSON result.

Read requests never call Graphify's CLI/server loaders, query logging or detectors.
The audit hook denies filesystem writes, subprocesses and networking in read mode.
"""
import sys
sys.dont_write_bytecode = True
import json
import os
import importlib.metadata
from pathlib import Path

# OS address-space cap where supported; conservative collection admission below
# also applies on platforms without resource controls.
resource_controls = {"addressSpaceBytes": None, "cpuSeconds": None,
                     "memoryEnforcement": "collection-admission-only"}
try:
    import resource
    try:
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
        resource_controls["addressSpaceBytes"] = 512 * 1024 * 1024
        resource_controls["memoryEnforcement"] = "os-address-space-limit"
    except (ValueError, OSError):
        pass
    try:
        resource.setrlimit(resource.RLIMIT_CPU, (300, 300))
        resource_controls["cpuSeconds"] = 300
    except (ValueError, OSError):
        pass
except ImportError:
    pass
MAX_WIRE = 128 * 1024 * 1024
raw = sys.stdin.buffer.read(MAX_WIRE + 1)
if len(raw) > MAX_WIRE:
    raise ValueError("bridge input limit exceeded")
request = json.loads(raw)
write_root = Path(request["staging"]).resolve() if request.get("action") == "extract" else None


def audit(event, args):
    if event.startswith(("socket.", "subprocess.", "os.system", "os.exec", "os.spawn", "os.fork", "os.posix_spawn")):
        raise PermissionError("graph bridge cannot start processes or use network")
    paths = []
    if event == "open":
        path, mode, flags = args
        writing = isinstance(mode, str) and any(c in mode for c in "wax+")
        writing = writing or isinstance(flags, int) and bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
        if writing:
            paths = [path]
    elif event in ("os.mkdir", "os.remove", "os.rmdir", "os.chmod", "os.utime", "os.truncate"):
        paths = [args[0]]
    elif event in ("os.rename", "os.link", "os.symlink"):
        paths = list(args[:2])
    for path in paths:
        # fdopen on an already confined tempfile descriptor is safe: this child
        # inherits only stdio and all path-based writable opens pass this hook.
        if write_root and isinstance(path, int):
            continue
        if not write_root or not isinstance(path, (str, bytes)) or not Path(os.fsdecode(path)).resolve().is_relative_to(write_root):
            raise PermissionError("graph bridge write outside authorized staging")


sys.addaudithook(audit)


def main():
    version = importlib.metadata.version("graphifyy")
    if version != "0.9.82":
        raise ValueError("incompatible Graphify version: " + version)
    if request.get("action") == "probe":
        import graphify.serve
        return {"version": version, "schema": 1, "python": sys.version.split()[0]}
    if request.get("action") == "extract":
        from graphify.extract import extract
        from graphify.build import build_from_json
        from networkx.readwrite import json_graph
        root = write_root / "input"
        paths = []
        for relative in request["paths"]:
            path = (root / relative).resolve()
            if not path.is_relative_to(root) or path.is_symlink():
                raise ValueError("escaped captured input")
            paths.append(path)
        # Copy only content/version-keyed AST entries for the current capture.
        # Upstream rebases portable cached IDs onto this immutable input root.
        import hashlib
        from graphify import cache
        copied = 0
        parent = request.get("parentCache")
        expected = request.get("cacheChecksums", {})
        if parent:
            namespace = "graphify-out/cache/ast/v" + version + "-s" + str(cache._AST_CACHE_SCHEMA)
            for path in paths:
                key = cache.file_hash(path, root, cache_root=write_root)
                relative = namespace + "/" + key + ".json"
                previous = Path(parent) / relative
                if relative not in expected or not previous.is_file() or previous.is_symlink():
                    continue
                if previous.stat().st_size > 8 * 1024 * 1024:
                    raise ValueError("AST cache item budget exceeded")
                content = previous.read_bytes()
                if hashlib.sha256(content).hexdigest() != expected[relative]:
                    raise ValueError("AST cache checksum mismatch")
                target = write_root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                copied += 1
        # All caches and parser work remain inside owned staging; no worker pool.
        result = extract(paths, root=root, cache_root=write_root, parallel=False)
        if result.get("failed_sources"):
            raise ValueError("AST failed inputs: " + repr(result["failed_sources"][:20]))
        # Never persist staging-directory identities as portable provenance.
        def portable(value):
            if isinstance(value, str):
                return value.replace(str(root) + os.sep, "")
            if isinstance(value, list):
                return [portable(v) for v in value]
            if isinstance(value, dict):
                return {k: portable(v) for k, v in value.items()}
            return value
        result = portable(result)
        semantic = request.get("semantic", {"nodes": [], "edges": []})
        result["nodes"].extend(semantic.get("nodes", []))
        result["edges"].extend(semantic.get("edges", []))
        graph = build_from_json(result, root=root, directed=True)
        from graphify.export import to_html
        if not to_html(graph, {}, str(write_root / "graph.html"), learning_overlay={}):
            raise ValueError("Required graph visualization was not written")
        data = json_graph.node_link_data(graph, edges="links")
        data.setdefault("graph", {}).update(schema_version=1, graphify_version=version)
        cache_files = {}
        cache_base = write_root / "graphify-out" / "cache" / "ast"
        if cache_base.exists():
            for cached in cache_base.rglob("*.json"):
                cache_files[cached.relative_to(write_root).as_posix()] = hashlib.sha256(cached.read_bytes()).hexdigest()
        return {"graph": data, "extraction": result, "cacheFiles": cache_files, "reusedAstInputs": copied}

    import networkx as nx
    from networkx.readwrite import json_graph
    from graphify import serve
    # Optional jieba lazily writes a tokenizer cache. Use the pure fallback.
    serve._jieba = None
    data = request["graph"]
    if data.get("graph", {}).get("schema_version") != 1:
        raise ValueError("incompatible graph schema")
    nodes = data.get("nodes")
    links = data.get("links", data.get("edges"))
    if not isinstance(nodes, list) or not isinstance(links, list):
        raise ValueError("invalid graph collections")
    if len(nodes) > 100000 or len(links) > 300000:
        raise ValueError("graph memory admission limit exceeded")
    ids = {n["id"] for n in nodes}
    if len(ids) != len(nodes) or any(not isinstance(i, str) for i in ids):
        raise ValueError("invalid or duplicate node identity")
    if any(e.get("source") not in ids or e.get("target") not in ids or e.get("_src", e["source"]) not in ids or e.get("_tgt", e["target"]) not in ids for e in links):
        raise ValueError("dangling graph endpoint")
    graph = json_graph.node_link_graph({**data, "links": links, "directed": True}, edges="links")
    graph.graph["_logical_directed"] = bool(data.get("directed"))
    op = request["operation"]
    seeds = []
    ambiguous = False
    for seed in op.get("seeds", []):
        found = [seed] if seed in graph else serve._find_node(graph, seed)
        ambiguous = ambiguous or len(found) > 1
        seeds.extend(found[:16])
    if op["operation"] == "query":
        terms = serve._query_terms(op["query"])
        scores = serve._score_query(graph, terms, collect_per_term_seeds=True)
        seeds = serve._pick_seeds(scores.ranked, G=graph, best_seed_by_term=scores.best_seed_by_term)[:16]
    direction = op.get("direction", "both")
    view = serve._path_search_graph(graph, direction == "both")
    if direction == "incoming":
        view = view.reverse(copy=False)
    selected = set(seeds)
    if op["operation"] == "path" and len(seeds) == 1 and not ambiguous:
        targets = [op["target"]] if op["target"] in graph else serve._find_node(graph, op["target"])
        ambiguous = len(targets) > 1
        if len(targets) == 1:
            try:
                selected = set(nx.shortest_path(view, seeds[0], targets[0]))
            except nx.NetworkXNoPath:
                selected = set()
        else:
            selected = set(targets)
    elif op["operation"] not in ("node", "status") and not ambiguous and seeds:
        selected, _ = serve._bfs(view, seeds, op.get("depth", 2))
    if op["operation"] == "status":
        selected = set()
    selected_order = list(dict.fromkeys([n for n in seeds if n in selected] + sorted(selected)))[:500]
    kept = set(selected_order)
    edges = [e for e in links if e["source"] in kept and e["target"] in kept]
    return {"nodes": [{"id": n, **dict(graph.nodes[n])} for n in selected_order], "edges": edges[:1000], "ambiguous": ambiguous,
            "truncated": len(selected) > len(kept) or len(edges) > 1000, "nodeCount": len(nodes), "edgeCount": len(links)}


try:
    # Libraries occasionally print extraction diagnostics. Keep stdout framed.
    import contextlib
    with contextlib.redirect_stdout(sys.stderr):
        result = main()
    result["resourceControls"] = resource_controls
    sys.stdout.write(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
except Exception as error:
    sys.stdout.write(json.dumps({"ok": False, "error": str(error)[:2000]}))
    sys.exit(1)
