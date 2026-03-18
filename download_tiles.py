import os, requests, time, math

def deg2tile(lat, lon, zoom):
    lat_r = math.radians(lat)
    n = 2 ** zoom
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.log(math.tan(lat_r) + 1/math.cos(lat_r)) / math.pi) / 2 * n)
    return x, y

def download_tiles(name, lat_min, lat_max, lon_min, lon_max, zoom_min, zoom_max):
    total = 0
    for z in range(zoom_min, zoom_max + 1):
        x_min, y_max = deg2tile(lat_min, lon_min, z)
        x_max, y_min = deg2tile(lat_max, lon_max, z)
        count = (x_max-x_min+1) * (y_max-y_min+1)
        print(f"[{name}] z={z}: {count} tiles")
        for x in range(x_min, x_max + 1):
            for y in range(y_min, y_max + 1):
                path = f"/home/ember/EMBER/tiles/{z}/{x}/{y}.png"
                if os.path.exists(path):
                    continue
                os.makedirs(f"/home/ember/EMBER/tiles/{z}/{x}", exist_ok=True)
                url = f"https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                try:
                    r = requests.get(url, headers={"User-Agent":"EmberCannon/1.0"}, timeout=10)
                    if r.status_code == 200:
                        with open(path, "wb") as f:
                            f.write(r.content)
                        total += 1
                        if total % 50 == 0:
                            print(f"  {total} tiles downloaded...")
                    time.sleep(0.1)
                except Exception as e:
                    print(f"Error: {e}")
    print(f"[{name}] Done! {total} tiles.")

# Hinchinbrooke
download_tiles("Hinchinbrooke",
    lat_min=45.05, lat_max=45.20,
    lon_min=-74.20, lon_max=-74.00,
    zoom_min=10, zoom_max=18)

# Montreal downtown
download_tiles("Montreal",
    lat_min=45.47, lat_max=45.53,
    lon_min=-73.62, lon_max=-73.54,
    zoom_min=10, zoom_max=18)
