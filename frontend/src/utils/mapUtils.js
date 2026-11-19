export const MAP_CONFIG = {
  ascent: {
    name: 'Ascent',
    xMult: 0.00007,
    yMult: -0.00007,
    xAdd: 0.813895,
    yAdd: 0.573242,
    icon: 'https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/displayicon.png'
  },
  bind: {
    name: 'Bind',
    xMult: 0.000059,
    yMult: -0.000059,
    xAdd: 0.576941,
    yAdd: 0.967566,
    icon: 'https://media.valorant-api.com/maps/2c9d57ec-4431-9c5e-2939-8f9ef6dd5cba/displayicon.png'
  },
  haven: {
    name: 'Haven',
    xMult: 0.000075,
    yMult: -0.000075,
    xAdd: 1.09345,
    yAdd: 0.642728,
    icon: 'https://media.valorant-api.com/maps/2bee0dc9-4ffe-519b-1cbd-7fbe763a6047/displayicon.png'
  },
  split: {
    name: 'Split',
    xMult: 0.000078,
    yMult: -0.000078,
    xAdd: 0.842188,
    yAdd: 0.697578,
    icon: 'https://media.valorant-api.com/maps/d960549e-485c-e861-8d71-aa9d1aed12a2/displayicon.png'
  },
  lotus: {
    name: 'Lotus',
    xMult: 0.000072,
    yMult: -0.000072,
    xAdd: 0.454789,
    yAdd: 0.917752,
    icon: 'https://media.valorant-api.com/maps/2fe4ed3a-450a-948b-6d6b-e89a78e680a9/displayicon.png'
  },
  sunset: {
    name: 'Sunset',
    xMult: 0.000078,
    yMult: -0.000078,
    xAdd: 0.5,
    yAdd: 0.515625,
    icon: 'https://media.valorant-api.com/maps/92584fbe-486a-b1b2-9faa-39b0f486b498/displayicon.png'
  },
  abyss: {
    name: 'Abyss',
    xMult: 0.000081,
    yMult: -0.000081,
    xAdd: 0.5,
    yAdd: 0.5,
    icon: 'https://media.valorant-api.com/maps/224b0a95-48b9-f703-1bd8-67aca101a61f/displayicon.png'
  },
  corrode: {
    name: 'Corrode',
    xMult: 0.00007,
    yMult: -0.00007,
    xAdd: 0.526158,
    yAdd: 0.5,
    icon: 'https://media.valorant-api.com/maps/1c18ab1f-420d-0d8b-71d0-77ad3c439115/displayicon.png'
  },
  icebox: {
    name: 'Icebox',
    xMult: 0.000072,
    yMult: -0.000072,
    xAdd: 0.460214,
    yAdd: 0.304687,
    icon: 'https://media.valorant-api.com/maps/e2ad5c54-4114-a870-9641-8ea21279579a/displayicon.png'
  },
  breeze: {
    name: 'Breeze',
    xMult: 0.00007,
    yMult: -0.00007,
    xAdd: 0.465123,
    yAdd: 0.833078,
    icon: 'https://media.valorant-api.com/maps/2fb9a4fd-47b8-4e7d-a969-74b4046ebd53/displayicon.png'
  },
  fracture: {
    name: 'Fracture',
    xMult: 0.000078,
    yMult: -0.000078,
    xAdd: 0.556952,
    yAdd: 1.155886,
    icon: 'https://media.valorant-api.com/maps/b529448b-4d60-346e-e89e-00a4c527a405/displayicon.png'
  },
  pearl: {
    name: 'Pearl',
    xMult: 0.000078,
    yMult: -0.000078,
    xAdd: 0.480469,
    yAdd: 0.916016,
    icon: 'https://media.valorant-api.com/maps/fd267378-4d1d-484f-ff52-77821ed10dc2/displayicon.png'
  },
  summit: {
    name: 'Summit',
    xMult: 0.000075,
    yMult: -0.000075,
    xAdd: 0.047401,
    yAdd: 0.978891,
    icon: 'https://media.valorant-api.com/maps/756da597-416b-c0f2-f47b-afbdf28670bc/displayicon.png'
  }
};

/**
 * World (game units) -> minimap percent, using valorant-api.com's per-map calibration.
 * One formula for every map: image x from game Y, image y from game X (validated: 97.8-100% of
 * real deaths land on drawn map pixels for all 8 pool maps; the old "xy" special case put ~50%
 * of Abyss/Corrode deaths off the map). Returns null for maps without calibration.
 * Not clamped: off-image points must stay off-image, not get pinned to the edge.
 */
export function worldToMiniMap(x, y, mapName) {
  const config = MAP_CONFIG[(mapName || '').toLowerCase().trim()];
  if (!config || x == null || y == null) return null;
  return {
    left: (y * config.xMult + config.xAdd) * 100,
    top: (x * config.yMult + config.yAdd) * 100
  };
}

/**
 * In-game view angle (radians, world axes) -> CSS rotation in degrees on the minimap,
 * with the same axis swap and scale signs as worldToMiniMap.
 */
export function minimapViewAngleDeg(viewRadians, mapName) {
  const config = MAP_CONFIG[(mapName || '').toLowerCase().trim()];
  if (viewRadians == null || !config) return null;
  const dx = Math.sin(viewRadians) * config.xMult;
  const dy = Math.cos(viewRadians) * config.yMult;
  return Math.atan2(dy, dx) * (180 / Math.PI);
}
