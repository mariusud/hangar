import type { ImageSpec } from '../db.ts';
import { imageBuilds, imageHosts, imageView, isEnvName, loadImageSetup, MAX_FLOW_BYTES, parseImageSetup, refreshApps, saveImageSetup } from '../images.ts';
import { ApiError } from '../leases/service.ts';
import { body, json, me, operator, route } from './util.ts';

route('GET', '/v1/images', (req, res, ctx) => {
  me(req, ctx);
  const hosts = [...ctx.hosts.hosts.values()];
  json(
    res,
    200,
    ctx.db.images().map((spec) => ({ ...imageView(spec, loadImageSetup(ctx.db, spec.name)), builds: imageBuilds(ctx.db, spec), ...imageHosts(spec.name, hosts) })),
  );
});

// A new build of the image's app. Hosts build a new golden device; leases on the old one keep
// running, and new leases get the new build once it is ready.
route('POST', '/v1/images/:name/refresh', async (req, res, ctx) => {
  const p = operator(req, ctx);
  const name = req.params.name ?? '';
  const spec = ctx.db.images().find((i) => i.name.toLowerCase() === name.toLowerCase());
  if (!spec) {
    throw new ApiError(404, 'IMAGE_NOT_FOUND', `No image called ${name}.`, 'Declare it with `hangar image set`.');
  }
  const b = await body<{ apps?: unknown }>(req, 64 * 1024);
  if (b.apps !== undefined && !Array.isArray(b.apps)) {
    throw new ApiError(400, 'NO_BUILD', 'apps is a list of build names or sha256 values, such as ["App.app"].');
  }
  const builds = (b.apps ?? []).map((ref) => {
    const build = ctx.db.getBuild(String(ref));
    if (!build) {
      throw new ApiError(404, 'BUILD_NOT_FOUND', `No build called ${String(ref)}.`, 'Upload it first with POST /v1/builds, or list them at GET /v1/builds.');
    }
    return { sha256: build.sha256, name: build.name };
  });
  const setup = loadImageSetup(ctx.db, spec.name);
  const next: ImageSpec = { ...spec, apps: refreshApps(imageBuilds(ctx.db, spec), builds) };
  const changed = imageView(next, setup).id !== imageView(spec, setup).id;
  if (changed) {
    ctx.db.saveImage(next);
    ctx.db.audit(`image.refresh ${spec.name}`, p.accountId, null);
    ctx.publishImages();
  }
  json(res, 200, { ...imageView(next, setup), builds: imageBuilds(ctx.db, next), changed });
});

route('PUT', '/v1/images/:name', async (req, res, ctx) => {
  operator(req, ctx);
  const name = req.params.name ?? '';
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(name)) {
    throw new ApiError(400, 'BAD_IMAGE_NAME', 'Image names are letters, digits, dots, dashes and underscores, up to 63 characters.');
  }
  const b = await body<{ apps?: string[]; locale?: string; appearance?: string; grants?: unknown; signIn?: unknown }>(req, MAX_FLOW_BYTES * 2);
  const apps: string[] = [];
  for (const ref of b.apps ?? []) {
    const build = ctx.db.getBuild(ref);
    if (!build) {
      throw new ApiError(404, 'BUILD_NOT_FOUND', `No build called ${ref}.`, 'Upload it first with POST /v1/builds, or list them at GET /v1/builds.');
    }
    apps.push(build.sha256);
  }
  if (b.locale !== undefined && !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(b.locale)) {
    throw new ApiError(400, 'BAD_LOCALE', `${b.locale} is not a locale. Write it like nb_NO or en_US.`);
  }
  if (b.appearance !== undefined && b.appearance !== 'light' && b.appearance !== 'dark') {
    throw new ApiError(400, 'BAD_APPEARANCE', 'appearance is light or dark.');
  }
  const setup = parseImageSetup(b);
  if (setup.grants && !apps.length) {
    throw new ApiError(400, 'GRANTS_NEED_APPS', 'Permissions are granted to the image\'s apps, and this image has none.', 'Add an app with --app.');
  }
  const spec: ImageSpec = { name, apps };
  if (b.locale) {
    spec.locale = b.locale;
  }
  if (b.appearance) {
    spec.appearance = b.appearance;
  }
  ctx.db.saveImage(spec);
  saveImageSetup(ctx.db, name, setup);
  ctx.publishImages();
  json(res, 200, imageView(spec, setup));
});

route('DELETE', '/v1/images/:name', (req, res, ctx) => {
  operator(req, ctx);
  if (!ctx.db.removeImage(req.params.name ?? '')) {
    throw new ApiError(404, 'IMAGE_NOT_FOUND', `No image called ${req.params.name}.`);
  }
  saveImageSetup(ctx.db, req.params.name ?? '', {});
  ctx.publishImages();
  res.writeHead(204).end();
});

// Values for the names a sign-in flow reads. Only names and times ever come back.
route('GET', '/v1/image-secrets', (req, res, ctx) => {
  operator(req, ctx);
  json(res, 200, ctx.db.imageSecrets());
});

route('PUT', '/v1/image-secrets/:name', async (req, res, ctx) => {
  const p = operator(req, ctx);
  const name = req.params.name ?? '';
  if (!isEnvName(name)) {
    throw new ApiError(400, 'BAD_ENV_NAME', `${name} is not an environment variable name. Use letters, digits and underscores.`);
  }
  const b = await body<{ value?: unknown }>(req, 64 * 1024);
  if (typeof b.value !== 'string' || !b.value) {
    throw new ApiError(400, 'BAD_SECRET', 'Send the value as {"value": "..."}.');
  }
  ctx.db.saveImageSecret(name, b.value, Date.now());
  ctx.db.audit(`image-secret.set ${name}`, p.accountId, null);
  ctx.publishImages();
  res.writeHead(204).end();
});

route('DELETE', '/v1/image-secrets/:name', (req, res, ctx) => {
  const p = operator(req, ctx);
  if (!ctx.db.removeImageSecret(req.params.name ?? '')) {
    throw new ApiError(404, 'SECRET_NOT_FOUND', `No secret called ${req.params.name}.`);
  }
  ctx.db.audit(`image-secret.remove ${req.params.name}`, p.accountId, null);
  ctx.publishImages();
  res.writeHead(204).end();
});
