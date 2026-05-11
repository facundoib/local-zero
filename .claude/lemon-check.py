import urllib.request as u, json, sys

try:
    r = u.urlopen("http://localhost:13305/api/v1/models", timeout=3)
    d = json.load(r)
    ids = [m["id"] for m in d.get("data", [])]
    if ids:
        print("Lemonade OK — models: " + ", ".join(ids))
    else:
        print("Lemonade OK — no models loaded")
except Exception as e:
    print(f"Lemonade DOWN — {e}")
