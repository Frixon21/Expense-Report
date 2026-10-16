export const today = () => new Date().toLocaleDateString("en-CA");

export const monthStart = () => `${today().slice(0, 7)}-01`;

export const monthEnd = () => {
  const date = new Date();
  return new Date(
    date.getFullYear(),
    date.getMonth() + 1,
    0,
  ).toLocaleDateString("en-CA");
};
