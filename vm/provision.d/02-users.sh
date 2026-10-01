# shellcheck shell=bash
getent group workspace >/dev/null || groupadd -g "$WORKSPACE_GID" workspace
getent group docker >/dev/null || groupadd -g "$DOCKER_GID" docker
getent group agent >/dev/null || groupadd -g "$AGENT_UID" agent
if ! getent passwd agent >/dev/null; then
  useradd -u "$AGENT_UID" -g "$AGENT_UID" -G workspace,docker -m -d /home/agent -s /bin/bash -c "Milibot agent" agent
fi
usermod -a -G workspace,docker agent
chmod 750 /home/agent
