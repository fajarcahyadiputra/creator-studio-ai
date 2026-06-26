SHELL := /bin/sh

.PHONY: setup up down logs ps migrate seed test typecheck lint format clean

setup:
	cp -n .env.example .env || true
	npm install
	npm run prisma:generate

up:
	docker compose up --build

down:
	docker compose down

logs:
	docker compose logs -f --tail=200

ps:
	docker compose ps

migrate:
	docker compose run --rm migrate

seed:
	docker compose run --rm seed

test:
	npm test
	cd apps/ai-media-python && python -m pytest

typecheck:
	npm run typecheck
	cd apps/ai-media-python && python -m mypy app

lint:
	npm run lint
	cd apps/ai-media-python && python -m ruff check .

format:
	npm run format
	cd apps/ai-media-python && python -m ruff format .

clean:
	rm -rf node_modules apps/*/node_modules packages/*/node_modules
	rm -rf apps/*/dist packages/*/dist
	rm -rf apps/ai-media-python/.venv apps/ai-media-python/.pytest_cache
