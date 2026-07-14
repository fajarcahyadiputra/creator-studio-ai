SHELL := cmd
.SHELLFLAGS := /C
COMPOSE := docker compose
DEV_COMPOSE := docker compose -f docker-compose.yml -f docker-compose.dev.yml

.PHONY: setup docker-check doctor-dev up up-dev watch-dev down down-dev logs logs-dev ps ps-dev migrate seed test typecheck lint format clean

docker-check:
	@docker info >NUL 2>&1 || (echo Docker daemon belum bisa diakses. && echo Pastikan Docker Desktop sudah running. && echo Kalau di Windows, pastikan mode-nya Linux containers. && echo Lalu coba jalankan: docker context use desktop-linux && echo Sesudah itu ulangi perintah make. && exit /B 1)

doctor-dev: docker-check
	@echo Docker daemon siap.
	@docker context show
	@$(DEV_COMPOSE) config >NUL && echo Compose config OK.

setup:
	@if not exist .env copy .env.example .env >NUL
	npm install
	npm run prisma:generate

up: docker-check
	$(COMPOSE) up --build

up-dev: docker-check
	$(DEV_COMPOSE) up -d

watch-dev: docker-check
	$(DEV_COMPOSE) watch

down: docker-check
	$(COMPOSE) down

down-dev: docker-check
	$(DEV_COMPOSE) down

logs: docker-check
	$(COMPOSE) logs -f --tail=200

logs-dev: docker-check
	$(DEV_COMPOSE) logs -f --tail=200

ps: docker-check
	$(COMPOSE) ps

ps-dev: docker-check
	$(DEV_COMPOSE) ps

migrate: docker-check
	$(COMPOSE) run --rm migrate

seed: docker-check
	$(COMPOSE) run --rm seed

test:
	npm test
	cd /D apps\ai-media-python && python -m pytest

typecheck:
	npm run typecheck
	cd /D apps\ai-media-python && python -m mypy app

lint:
	npm run lint
	cd /D apps\ai-media-python && python -m ruff check .

format:
	npm run format
	cd /D apps\ai-media-python && python -m ruff format .

clean:
	@powershell -NoProfile -Command "$$paths = @('node_modules','apps/web-node/node_modules','apps/media-ingestion-node/node_modules','packages/contracts/node_modules','apps/web-node/dist','apps/media-ingestion-node/dist','packages/contracts/dist','apps/ai-media-python/.venv','apps/ai-media-python/.pytest_cache'); foreach ($$path in $$paths) { if (Test-Path $$path) { Remove-Item -Recurse -Force $$path } }"
