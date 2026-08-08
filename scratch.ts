import { uniform, float, attribute, add, mul, sin, Node } from 'three/tsl';
const uTime = uniform(0);
const aStartTime = attribute('aStartTime', 'float') as unknown as Node;
const rawLife = uTime.sub(aStartTime as any);
