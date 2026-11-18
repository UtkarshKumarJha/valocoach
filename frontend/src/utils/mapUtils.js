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
    icon: 'https://media.valorant-api.com/maps/2bee0dc9-4da5-3a78-9403-bc880a26b36e/displayicon.png'
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
  }
};

export function worldToMiniMap(x, y, mapName) {
  const key = (mapName || '').toLowerCase().trim();
  const config = MAP_CONFIG[key] || MAP_CONFIG.ascent;
  
  const canvasX = (y * config.xMult + config.xAdd) * 100;
  const canvasY = (x * config.yMult + config.yAdd) * 100;
  
  return {
    left: Math.max(3, Math.min(97, canvasX)),
    top: Math.max(3, Math.min(97, canvasY))
  };
}
