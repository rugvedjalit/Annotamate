## Summary

<!-- What does this change and why? Link the issue it closes, e.g. "Closes #123". -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactoring (no behaviour change)
- [ ] Documentation
- [ ] Build, CI or deployment

## How it was tested

<!-- Commands you ran, cases you checked by hand, screenshots for UI changes. -->

## Checklist

- [ ] The title follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat: ...`, `fix: ...`, `chore: ...`)
- [ ] Backend checks pass: `ruff check annotamate tests` and `pytest -q`
- [ ] Frontend checks pass: `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` (in `web/`)
- [ ] New behaviour is covered by tests (API endpoints, permission rules and path handling always are)
- [ ] API changes are reflected in `docs/api.md` and `web/src/lib/types.ts`
- [ ] User-visible changes are described in `CHANGELOG.md` and, where relevant, in `docs/guides/`
- [ ] No secrets, datasets or generated files (`annotamate/server/static/`, `node_modules/`) are committed
- [ ] Changes to workflows, dependencies, the container or security-sensitive code are explained above (new actions are pinned to a full commit SHA)
