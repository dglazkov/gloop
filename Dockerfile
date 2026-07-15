# Reference sandbox for running gloop. See README "Running in Docker".
FROM node:22-slim

# git + gh CLI (gloop drives GitHub via the gh CLI).
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git \
	&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
		-o /usr/share/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/*

# The mounted repo is typically owned by the host user: trust it, give git an
# identity for gloop's commits, and route git pushes through gh's credentials
# (GH_TOKEN) so `git push` works without extra setup.
RUN git config --system --add safe.directory '*' \
	&& git config --system user.name "gloop" \
	&& git config --system user.email "gloop@localhost" \
	&& git config --system credential."https://github.com".helper '!gh auth git-credential'

# Build gloop.
WORKDIR /gloop
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && npm cache clean --force

# Run against the repo mounted at /repo.
WORKDIR /repo
ENTRYPOINT ["node", "/gloop/dist/cli.js"]
