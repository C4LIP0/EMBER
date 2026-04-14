# EMBER – Wildfire Suppression Cannon Control System

## Overview
EMBER is a full-stack embedded control platform developed as an engineering capstone project for a wildfire suppression cannon. The system combines a **React frontend**, **Node.js/Express backend**, and **Raspberry Pi hardware integration** to provide real-time monitoring, calibration, actuator control, and remote operation through a web-based interface.

The platform was designed to act as the bridge between software and physical hardware, allowing an operator to monitor system status, read live sensor data, control movement, and trigger firing actions from a single interface.

---

## Project Objective
The goal of this project is to create a smart control system for a suppression cannon capable of:

- Monitoring live sensor data
- Supporting calibration and aiming workflows
- Controlling motors and firing mechanisms
- Providing operator feedback and system status in real time
- Enforcing safety checks before critical actions

---

## System Architecture

### Frontend
The frontend was built using **React** and provides the main operator dashboard for interacting with the system. It includes pages for:

- Dashboard overview
- Manual control
- Sensor status monitoring
- Calibration workflows
- Map and targeting interface

### Backend
The backend was developed using **Node.js** and **Express**. It serves as the central communication layer between the frontend and the Raspberry Pi hardware modules by:

- Exposing API endpoints to the frontend
- Reading data from connected sensors
- Launching and managing hardware-related processes
- Sending commands to motors and firing mechanisms
- Returning real-time status updates to the user interface

### Embedded / Hardware Layer
The system runs on a **Raspberry Pi**, which interfaces directly with the hardware components. It is responsible for reading sensor inputs and forwarding commands from the backend to the connected actuators and control modules.

---

## Main Features

- Real-time web-based control interface
- Live sensor monitoring
- Calibration recording and validation
- Manual motor control
- Firing and release control
- Safety interlocks and confirmation steps before shoot actions
- Hardware status feedback for each subsystem
- Modular backend structure for sensor and actuator integration

---

## Technologies Used

### Software
- **React**
- **Vite**
- **Node.js**
- **Express**
- **JavaScript**
- **Python** (for hardware/sensor scripts)
- **REST API communication**

### Hardware / Embedded
- **Raspberry Pi**
- Integrated sensors for orientation, pressure, and environmental feedback
- Motor control modules
- Firing/actuation mechanisms

---

## Repository Structure

```bash
EMBER/
├── backend/        # Express server, API routes, hardware control modules
├── frontend/       # React user interface
├── calibrations/   # Saved calibration data and records
└── README.md
