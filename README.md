# EMBER
On Raspberry Pi
Start frontend: cd /opt/ember/frontend
                npm run dev
Start backend: cd /opt/ember/backend


Before merging annything: (the system can operate at the moment the raspberry pi boot
sudo systemctl stop ember.service

sudo systemctl disable --now ember.service
After:
sudo systemctl enable --now ember.service

start once (without changing boot behaviour)
sudo systemctl start ember.service

One-liner “maintenance mode” (stop, update, start)
sudo systemctl stop ember.service && cd /opt/ember && git status
