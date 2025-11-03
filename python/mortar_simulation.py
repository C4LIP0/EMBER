# --- Auto-added helper: import hints ---
# If you see ImportError, install dependencies with: pip install -r requirements.txt
import numpy as np
import matplotlib.pyplot as plt
import requests
from math import radians, degrees, cos, sin, atan2, exp
from scipy.optimize import minimize

# === 🔑 ENTER YOUR GOOGLE ELEVATION API KEY HERE ===
import os
GOOGLE_API_KEY = os.getenv("AIzaSyC9GO3tcbgRWaHOJFUB89noM-BZNGWnqe0", "PUT_YOUR_KEY_HERE")

# === CONSTANTS (projectile) ===
g = 9.81
rho0 = 1.225
Cd = 0.35
A = 0.005
mass = 1.0

# === USER INPUT ===
def get_coordinate(prompt, default=None):
    while True:
        val = input(f"{prompt} (lat,lon) [{default[0]},{default[1]}]: ").strip()
        if not val and default:
            return default
        try:
            lat, lon = map(float, val.split(","))
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                return (lat, lon)
            else:
                print("Coordinates out of range.")
        except:
            print("Invalid format. Use lat,lon")

# === COORDINATE CONVERSION ===
def latlon_to_xy(lat1, lon1, lat2, lon2):
    R = 6371000
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    avg_lat = radians((lat1 + lat2) / 2)
    dx = R * dlon * cos(avg_lat)
    dy = R * dlat
    return dx, dy

def xy_to_latlon(lat0, lon0, dx, dy):
    R = 6371000
    dlat = dy / R
    dlon = dx / (R * cos(radians(lat0)))
    return (lat0 + degrees(dlat), lon0 + degrees(dlon))

# === PHYSICS UTILITY ===
def air_density(elev):
    return rho0 * exp(-elev / 8434.5)

# === GOOGLE ELEVATION API CALL ===
elevation_cache = {}

def get_elevation(latlons):
    uncached = [loc for loc in latlons if loc not in elevation_cache]
    if uncached:
        locations = "|".join([f"{lat},{lon}" for lat, lon in uncached])
        url = f"https://maps.googleapis.com/maps/api/elevation/json?locations={locations}&key={GOOGLE_API_KEY}"
        r = requests.get(url).json()
        if r["status"] == "OK":
            for loc, result in zip(uncached, r["results"]):
                elevation_cache[loc] = result["elevation"]
        else:
            raise Exception("Google Elevation API error:", r)
    return np.array([elevation_cache[loc] for loc in latlons])

# === TRAJECTORY SIMULATION ===
def simulate_trajectory(v0, elev_deg, azim_deg, wind, launch_alt, dt=0.01, max_t=120):
    elev = radians(elev_deg)
    azim = radians(azim_deg)
    vx = v0 * cos(elev) * cos(azim)
    vy = v0 * cos(elev) * sin(azim)
    vz = v0 * sin(elev)
    pos = np.array([0.0, 0.0, launch_alt])
    vel = np.array([vx, vy, vz])
    path = [pos.copy()]
    for _ in np.arange(0, max_t, dt):
        rel_vel = vel - wind
        vmag = np.linalg.norm(rel_vel)
        drag = -0.5 * air_density(pos[2]) * Cd * A * vmag * rel_vel / mass
        acc = np.array([0, 0, -g]) + drag
        vel += acc * dt
        pos += vel * dt
        path.append(pos.copy())
        if pos[2] < 0:
            break
    return np.array(path)

# === ERROR FUNCTION (horizontal error only) ===
def trajectory_error(params, dx, dy, dz, wind, start_elev, target_elev):
    v0, elev, azim = params
    if not (50 <= v0 <= 300 and 45 <= elev <= 85 and 0 <= azim < 360):
        return 1e6  # Penalize out-of-bounds
    try:
        path = simulate_trajectory(v0, elev, azim, wind, start_elev)
    except Exception as e:
        print(f"Simulation error: {e}")
        return 1e6
    final = path[-1]
    horizontal_error = np.linalg.norm([final[0] - dx, final[1] - dy])
    return horizontal_error

# === BEARING CALCULATION ===
def calculate_bearing(lat1, lon1, lat2, lon2):
    dlon = radians(lon2 - lon1)
    lat1 = radians(lat1)
    lat2 = radians(lat2)
    y = sin(dlon) * cos(lat2)
    x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dlon)
    bearing = atan2(y, x)
    return (degrees(bearing) + 360) % 360

# === REAL WORLD ACETYLENE CALCULATIONS FOR CHAMBER ===
def chamber_stoichiometric_limits(chamber_diam, chamber_len, molar_heat=1299000, molar_mass=26.04, efficiency=0.8, T=298):
    # chamber_diam: m
    # chamber_len: m
    r = chamber_diam / 2
    V = np.pi * r**2 * chamber_len  # m^3

    # Air is 21% O2 by volume
    V_O2 = 0.21 * V  # m^3

    # At STP, 1 mol gas = 22.4 L = 0.0224 m^3
    mol_O2 = V_O2 / 0.0224  # moles O2

    # Stoichiometry: 2 C2H2 + 5 O2
    mol_C2H2 = (2/5) * mol_O2

    mass_C2H2 = mol_C2H2 * molar_mass  # grams

    energy = mol_C2H2 * molar_heat * efficiency  # J

    R = 8.314  # J/(mol·K)
    P_C2H2 = (mol_C2H2 * R * T) / V  # Pa
    P_C2H2_bar = P_C2H2 / 1e5  # bar

    V_C2H2_STP = mol_C2H2 * 0.0224  # m^3

    return V, mol_C2H2, mass_C2H2, energy, P_C2H2, P_C2H2_bar, V_C2H2_STP

def required_acetylene_for_velocity(v0, mass, chamber_diam, chamber_len, efficiency=0.8, molar_heat=1299000, molar_mass=26.04, T=298):
    # Compute required chemical energy
    KE = 0.5 * mass * v0**2  # J
    required_energy = KE / efficiency

    # Chamber volume and stoichiometric limits
    V, mol_C2H2_max, mass_C2H2_max, energy_max, P_C2H2_max, P_C2H2_bar_max, V_C2H2_STP_max = chamber_stoichiometric_limits(
        chamber_diam, chamber_len, molar_heat, molar_mass, efficiency, T
    )

    # If required energy is above max, cap at max
    if required_energy > energy_max:
        return {
            "possible": False,
            "max_velocity": np.sqrt(2 * energy_max * efficiency / mass),
            "V": V,
            "mol_C2H2_max": mol_C2H2_max,
            "mass_C2H2_max": mass_C2H2_max,
            "energy_max": energy_max,
            "P_C2H2_bar_max": P_C2H2_bar_max,
            "V_C2H2_STP_max": V_C2H2_STP_max
        }
    # Otherwise, calculate required acetylene
    mol_C2H2 = required_energy / (molar_heat * efficiency)
    mass_C2H2 = mol_C2H2 * molar_mass
    R = 8.314
    P_C2H2 = (mol_C2H2 * R * T) / V
    P_C2H2_bar = P_C2H2 / 1e5
    V_C2H2_STP = mol_C2H2 * 0.0224

    return {
        "possible": True,
        "V": V,
        "mol_C2H2": mol_C2H2,
        "mass_C2H2": mass_C2H2,
        "energy": required_energy,
        "P_C2H2_bar": P_C2H2_bar,
        "V_C2H2_STP": V_C2H2_STP,
        "mol_C2H2_max": mol_C2H2_max,
        "mass_C2H2_max": mass_C2H2_max,
        "energy_max": energy_max,
        "P_C2H2_bar_max": P_C2H2_bar_max,
        "V_C2H2_STP_max": V_C2H2_STP_max
    }

# === MAIN ===
def main():
    default_start = (43.810542, -79.119873)
    default_end = (43.700111, -79.416298)

    start_ll = get_coordinate("Enter launch location", default_start)
    end_ll = get_coordinate("Enter target location", default_end)

    print("Using constant eastward wind: 5 m/s")
    wind = np.array([5.0, 0.0, 0.0])

    print("Fetching elevations...")
    elevs = get_elevation([start_ll, end_ll])
    start_elev, end_elev = elevs

    dx, dy = latlon_to_xy(*start_ll, *end_ll)
    dz = end_elev - start_elev

    max_range = 0.7 * (300**2) / g
    straight_line_dist = np.sqrt(dx**2 + dy**2)
    if straight_line_dist > max_range:
        print(f"Target is too far ({straight_line_dist:.1f} m), max theoretical range is {max_range:.1f} m")
        return

    # Calculate bearing from launch to target for initial azimuth guess
    bearing = calculate_bearing(*start_ll, *end_ll)
    print(f"Initial bearing (azimuth): {bearing:.2f}°")

    best_error = float("inf")
    best_params = None
    trial = 0

    # Multi-start optimization: try several initial guesses
    for v0_guess in [150, 200, 250]:
        for elev_guess in [55, 60, 65]:
            trial += 1
            print(f"Starting optimizer trial {trial}: v0={v0_guess}, elev={elev_guess}, azim={bearing:.2f}")
            result = minimize(
                trajectory_error,
                [v0_guess, elev_guess, bearing],
                args=(dx, dy, dz, wind, start_elev, end_elev),
                bounds=[(50, 300), (45, 85), (0, 359.99)],
                method='Powell',
                options={'maxiter': 500, 'disp': False}
            )
            if result.success:
                err = trajectory_error(result.x, dx, dy, dz, wind, start_elev, end_elev)
                print(f"  Trial {trial} result: v0={result.x[0]:.2f}, elev={result.x[1]:.2f}, azim={result.x[2]:.2f}, error={err:.2f} m")
                if err < best_error:
                    best_error = err
                    best_params = result.x
            else:
                print(f"  Trial {trial} failed.")

    if best_params is not None:
        v0_opt, elev_opt, azim_opt = best_params
        print(f"Optimal parameters: v0={v0_opt:.2f} m/s, elev={elev_opt:.2f}°, azim={azim_opt:.2f}°")
        print(f"Final horizontal error: {best_error:.2f} m")
        path = simulate_trajectory(v0_opt, elev_opt, azim_opt, wind, start_elev)

        # --- Real-World Acetylene Calculation (combustion chamber 80mm x 200mm) ---
        chamber_diam = 0.08  # 80 mm
        chamber_len = 0.2    # 200 mm

        acet = required_acetylene_for_velocity(
            v0_opt, mass, chamber_diam, chamber_len, efficiency=0.8
        )

        print("\n--- Real-World Acetylene Calculation (Combustion Chamber 80x200mm) ---")
        print(f"Combustion chamber volume: {acet['V']*1e3:.2f} L")

        if acet["possible"]:
            print(f"Required acetylene for this shot: {acet['mol_C2H2']:.4f} mol ({acet['mass_C2H2']:.2f} g)")
            print(f"Volume of acetylene at STP: {acet['V_C2H2_STP']*1e3:.2f} L")
            print(f"Partial pressure of acetylene in chamber: {acet['P_C2H2_bar']:.3f} bar")
            print(f"Total chemical energy (with 80% efficiency): {acet['energy']:.1f} J")
        else:
            print("WARNING: Required velocity exceeds the maximum possible for this chamber!")
            print(f"Maximum possible acetylene (stoichiometric): {acet['mol_C2H2_max']:.4f} mol ({acet['mass_C2H2_max']:.2f} g)")
            print(f"Maximum chemical energy (with 80% efficiency): {acet['energy_max']:.1f} J")
            print(f"Maximum possible projectile velocity (1 kg): {acet['max_velocity']:.2f} m/s")
            print(f"Partial pressure of acetylene in chamber (max): {acet['P_C2H2_bar_max']:.3f} bar")
            print(f"Volume of acetylene at STP (max): {acet['V_C2H2_STP_max']*1e3:.2f} L")

    else:
        print("Optimization failed: No valid trajectory found.")
        return

    # 3D Plot
    fig = plt.figure(figsize=(12, 7))
    ax = fig.add_subplot(111, projection='3d')
    ax.plot(path[:,0], path[:,1], path[:,2], label="Trajectory")
    ax.scatter(0, 0, start_elev, c='green', label='Launch')
    ax.scatter(dx, dy, end_elev, c='red', label='Target')
    ax.set_xlabel("X (East, m)")
    ax.set_ylabel("Y (North, m)")
    ax.set_zlabel("Z (Elevation, m)")
    ax.set_title(f"Exit Velocity {v0_opt:.2f} m/s | Elev. {elev_opt:.2f}°, Azim. {azim_opt:.2f}°")
    ax.legend()
    plt.tight_layout()
    plt.show()

if __name__ == "__main__":
    main()