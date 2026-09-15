/** The original twelve sessions, unchanged from app.js at 4916e7d. */
const levels = {heavy: 0, medium: 1, light: 2};
const names = {heavy: "Heavy", medium: "Medium", light: "Light"};
const E = (cat, name, h, m, l, compound = false, body = false) => ({cat, name, rx: [h, m, l], compound, body});
export const templates = {
  UA: {name: "Upper A", focus: "Bench press + barbell row", ex: [
    E("Primary","Bench Press",[3,"4"],[3,"6"],[3,"8"],1),
    E("Primary","Barbell Row",[3,"6"],[3,"6"],[3,"8"],1),
    E("Secondary","Incline Dumbbell Press",[2,"8"],[2,"8"],[3,"10"]),
    E("Secondary","Dumbbell Row",[2,"8"],[2,"8"],[2,"10"]),
    E("Arms","Biceps Curl Variation",[3,"8"],[3,"10"],[3,"12"]),
    E("Arms","Triceps Extension Variation",[3,"8"],[3,"10"],[3,"12"]),
    E("Accessory","Rear Delt / Face Pull",[3,"8"],[3,"10"],[3,"12"]),
    E("Accessory","Lateral Raise Variation",[3,"8"],[3,"10"],[3,"12"])
  ]},
  UB: {name: "Upper B", focus: "OHP + weighted pull-up", ex: [
    E("Primary","Weighted Pull-up",[3,"5"],[2,"7"],[2,"10"],1,1),
    E("Primary","Barbell Overhead Press",[3,"5"],[2,"7"],[2,"10"],1),
    E("Secondary","Dumbbell Row",[2,"8"],[2,"8"],[2,"12"]),
    E("Secondary","Weighted Dip / Flat DB Press",[2,"8"],[2,"8"],[2,"12"],1),
    E("Arms","Biceps Curl Variation",[3,"8"],[3,"10"],[3,"12"]),
    E("Arms","Triceps Extension Variation",[3,"8"],[3,"10"],[3,"12"]),
    E("Accessory","Rear Delt / Face Pull",[3,"10"],[3,"10"],[3,"12"]),
    E("Accessory","Lateral Raise Variation",[3,"10"],[3,"10"],[3,"12"])
  ]},
  LA: {name: "Lower A", focus: "Back squat + Romanian deadlift", ex: [
    E("Primary","Back Squat",[3,"3"],[2,"5"],[2,"8"],1),
    E("Core","Hanging Leg Raise",[3,"8"],[2,"10"],[2,"8"]),
    E("Secondary","Romanian Deadlift",[2,"6"],[2,"7"],[2,"10"],1),
    E("Posterior","Reverse Hyperextension",[3,"12"],[2,"12"],[2,"12"]),
    E("Accessory","Leg Curl",[2,"10"],[2,"12"],[2,"10"]),
    E("Accessory","Leg Extension",[2,"10"],[2,"12"],[2,"10"]),
    E("Lower leg","Calf Raise",[3,"12"],[3,"12"],[3,"12"]),
    E("Lower leg","Tibialis Raise",[3,"12"],[3,"12"],[3,"12"]),
    E("Core","Ab Variation",[3,"12"],[3,"12"],[3,"12"])
  ]},
  LB: {name: "Lower B", focus: "Deadlift + front squat", ex: [
    E("Primary","Deadlift",[3,"1 / 3 / 5"],[3,"3 / 5 / 7"],[3,"6"],1),
    E("Mobility","Spinal Decompression",[1,"—"],[1,"—"],[1,"—"]),
    E("Secondary","Front Squat",[3,"5"],[3,"8"],[3,"10"],1),
    E("Core","Hanging Leg Raise",[3,"12"],[3,"12"],[3,"10"]),
    E("Accessory","Leg Curl",[2,"10"],[2,"12"],[2,"10"]),
    E("Accessory","Leg Extension",[2,"10"],[2,"12"],[2,"10"]),
    E("Lower leg","Calf Raise",[3,"12"],[3,"12"],[3,"12"]),
    E("Lower leg","Tibialis Raise",[3,"12"],[3,"12"],[3,"12"]),
    E("Core","Ab Variation",[3,"12"],[3,"12"],[3,"12"])
  ]}
};
export const sequence = [["UA","heavy"],["LA","medium"],["UB","light"],["LB","heavy"],["UA","medium"],["LA","light"],["UB","heavy"],["LB","medium"],["UA","light"],["LA","heavy"],["UB","medium"],["LB","light"]];
export const sessions = sequence.map(([key, intensity], i) => ({
  id: i + 1, key, intensity, name: `${names[intensity]} ${templates[key].name}`,
  focus: templates[key].focus,
  ex: templates[key].ex.map(e => ({...e, sets: e.rx[levels[intensity]][0], reps: e.rx[levels[intensity]][1]}))
}));
export const conditioning = ["None", "Assault bike · 3 × 1 min", "Rower · 3 × 1 min", "Zone 2 · 20–30 min"];
export const exerciseFor = name => Object.values(templates).flatMap(t => t.ex).find(e => e.name === name);
export const targetReps = (exercise, index) => exercise.reps.includes(" / ") ? exercise.reps.split(" / ")[index % 3] : exercise.reps;
