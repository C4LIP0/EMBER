import os, requests, time, math
from concurrent.futures import ThreadPoolExecutor

def deg2tile(lat, lon, zoom):
    lat_r = math.radians(lat)
    n = 2 ** zoom
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.log(math.tan(lat_r) + 1/math.cos(lat_r)) / math.pi) / 2 * n)
    return x, y

def download_tile(args):
    z, x, y = args
    path = f"/home/ember/EMBER/tiles/{z}/{x}/{y}.png"
    if os.path.exists(path):
        return "skip"
    os.makedirs(f"/home/ember/EMBER/tiles/{z}/{x}", exist_ok=True)
    server = ["a","b","c"][(x+y) % 3]
    url = f"https://{server}.tile.openstreetmap.org/{z}/{x}/{y}.png"
    try:
        r = requests.get(url, headers={"User-Agent":"EmberCannon/1.0"}, timeout=10)
        if r.status_code == 200:
            with open(path, "wb") as f:
                f.write(r.content)
            return "ok"
        return f"err:{r.status_code}"
    except Exception as e:
        return f"err:{e}"

def download_area(name, lat_min, lat_max, lon_min, lon_max, zoom_min, zoom_max):
    all_tiles = []
    for z in range(zoom_min, zoom_max + 1):
        x_min, y_max = deg2tile(lat_min, lon_min, z)
        x_max, y_min = deg2tile(lat_max, lon_max, z)
        tiles = [(z,x,y) for x in range(x_min, x_max+1) for y in range(y_min, y_max+1)]
        print(f"[{name}] z={z}: {len(tiles)} tiles")
        all_tiles.extend(tiles)

    print(f"Total: {len(all_tiles)} tiles")
    done = 0
    with ThreadPoolExecutor(max_workers=8) as ex:
        for result in ex.map(download_tile, all_tiles):
            done += 1
            if done % 200 == 0:
                print(f"  {done}/{len(all_tiles)} ({100*done//len(all_tiles)}%)")
    print(f"[{name}] Done!")

# Target area centered on 45.009142, -74.068943
# Download 2km around that point
download_area("Target",
    lat_min=44.99,  lat_max=45.03,
    lon_min=-74.12, lon_max=-74.02,
    zoom_min=10, zoom_max=18)
