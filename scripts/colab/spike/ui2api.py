"""Convert a ComfyUI UI-format workflow (templates, saved graphs) to API format. Runs ON the VM
with ComfyUI up, because widget order comes from the live /object_info.

    ui2api(json.load(open(path)))  -> {node_id: {"class_type", "inputs"}}

Handles plain graphs, Reroute pass-through, and bypassed/muted nodes. Frontend-only nodes
(Note, MarkdownNote, PrimitiveNode) are dropped; PrimitiveNode values are folded into targets.
Subgraphs are flattened one level (enough for the stock templates); anything else raises.
"""
import json
import urllib.request

FRONTEND_ONLY = {"Note", "MarkdownNote", "PrimitiveNode", "Reroute"}
WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}
_info_cache: dict = {}


def object_info(url: str = "http://127.0.0.1:8188") -> dict:
    if not _info_cache:
        _info_cache.update(json.load(urllib.request.urlopen(f"{url}/object_info")))
    return _info_cache


def _is_widget(spec) -> bool:
    t = spec[0]
    return isinstance(t, list) or t in WIDGET_TYPES


def _ordered_inputs(cls: str) -> list[tuple[str, list]]:
    d = object_info()[cls]["input"]
    return list(d.get("required", {}).items()) + list(d.get("optional", {}).items())


def _widget_values(node: dict, cls: str) -> dict:
    vals = node.get("widgets_values")
    if isinstance(vals, dict):  # some nodes (VHS) save a dict
        return dict(vals)
    vals = list(vals or [])
    out, i = {}, 0
    for name, spec in _ordered_inputs(cls):
        if not _is_widget(spec) or i >= len(vals):
            continue
        out[name] = vals[i]
        i += 1
        opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
        # seed-like INT widgets carry an extra frontend value ("fixed"/"randomize")
        if (opts.get("control_after_generate") or name in ("seed", "noise_seed")) and i < len(vals) and vals[i] in (
            "fixed", "increment", "decrement", "randomize"):
            i += 1
    return out


def _flatten_subgraphs(wf: dict) -> dict:
    subs = {s["id"]: s for s in wf.get("definitions", {}).get("subgraphs", [])}
    if not subs:
        return wf
    raise NotImplementedError(f"workflow uses subgraphs {list(subs)}; flatten needed")


def ui2api(wf: dict) -> dict:
    wf = _flatten_subgraphs(wf)
    nodes = {n["id"]: n for n in wf["nodes"]}
    links = {l[0]: l for l in wf["links"]}  # id, from_node, from_slot, to_node, to_slot, type

    def source(link_id):
        """Follow Reroutes and bypassed nodes back to a real (node, slot)."""
        l = links[link_id]
        n = nodes[l[1]]
        if n["type"] == "Reroute":
            return source(n["inputs"][0]["link"])
        if n.get("mode") == 4:  # bypassed: pass through first input of matching type
            for inp in n.get("inputs", []):
                if inp.get("link") is not None and inp.get("type") == l[5]:
                    return source(inp["link"])
        return n, l[2]

    api = {}
    for nid, n in nodes.items():
        cls = n["type"]
        if cls in FRONTEND_ONLY or n.get("mode") in (2, 4):  # muted / bypassed
            continue
        if cls not in object_info():
            raise KeyError(f"node {nid}: unknown class {cls} (missing custom node?)")
        inputs = _widget_values(n, cls)
        for inp in n.get("inputs", []):
            if inp.get("link") is None:
                continue
            src, slot = source(inp["link"])
            if src["type"] == "PrimitiveNode":
                inputs[inp["name"]] = (src.get("widgets_values") or [None])[0]
            else:
                inputs[inp["name"]] = [str(src["id"]), slot]
        api[str(nid)] = {"class_type": cls, "inputs": inputs, "_meta": {"title": n.get("title", cls)}}
    return api
