import jwt from "jsonwebtoken";

export const createAccessToken = ({
  userId,
  email,
  displayName = "",
  secret,
  expiresIn,
}) => {
  return jwt.sign(
    {
      sub: userId,
      email,
      displayName: String(displayName || "").trim(),
      type: "access",
    },
    secret,
    {
      expiresIn,
    }
  );
};

export const verifyAccessToken = ({ token, secret }) => {
  return jwt.verify(token, secret);
};
