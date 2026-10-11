"""What an upload can ask to track: user words resolved to the local detector's COCO classes."""

COCO = ["person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
        "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
        "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
        "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard",
        "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
        "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
        "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard",
        "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors",
        "teddy bear", "hair drier", "toothbrush"]
COCO_ID = {name: i for i, name in enumerate(COCO)}

ALIASES = {
    "pedestrian": "person", "people": "person", "player": "person", "athlete": "person", "runner": "person",
    "man": "person", "woman": "person", "kid": "person", "child": "person", "human": "person",
    "cyclist": "bicycle", "bike": "bicycle", "motorbike": "motorcycle", "scooter": "motorcycle",
    "automobile": "car", "lorry": "truck", "van": "car", "taxi": "car", "ship": "boat", "plane": "airplane",
    "ball": "sports ball", "football": "sports ball", "soccer ball": "sports ball", "basketball": "sports ball",
    "puppy": "dog", "pup": "dog", "doggo": "dog", "kitten": "cat", "kitty": "cat", "pony": "horse",
    "calf": "cow", "cattle": "cow", "lamb": "sheep", "duck": "bird", "goose": "bird", "pigeon": "bird",
}
IRREGULAR = {"people": "person", "men": "man", "women": "woman", "children": "child", "geese": "goose",
             "mice": "mouse", "cattle": "cattle", "sheep": "sheep"}
DEFAULT = ["car", "person", "bicycle"]


def _known(word: str) -> str | None:
    return word if word in COCO_ID else ALIASES.get(word)


def _singular(word: str) -> list[str]:
    if word in IRREGULAR:
        return [IRREGULAR[word]]
    forms = [word]
    if word.endswith("ies"):
        forms.append(word[:-3] + "y")
    if word.endswith("es"):
        forms.append(word[:-2])
    if word.endswith("s"):
        forms.append(word[:-1])
    return forms


def resolve(text: str) -> list[dict]:
    """"dogs, Player" -> [{"name": "dog", "detector": "dog"}, {"name": "player", "detector": "person"}].
    The name is the user's word, singular. Raises ValueError with a sentence for the viewer."""
    out, seen = [], set()
    for raw in text.split(","):
        word = " ".join(raw.lower().split())
        if not word:
            continue
        name = next((f for f in _singular(word) if _known(f)), None)
        if name is None:
            raise ValueError(f"Tube can't track \"{raw.strip()}\" yet. Try names like person, car, dog, bicycle, "
                             "player or ball.")
        if name not in seen:
            seen.add(name)
            out.append({"name": name, "detector": _known(name)})
    if not out:
        raise ValueError("Name at least one thing to track, like dog or person.")
    return out


def trackable() -> dict:
    return {"default": DEFAULT, "names": sorted(COCO), "aliases": ALIASES}
