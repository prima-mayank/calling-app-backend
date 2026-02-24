import jwt from "jsonwebtoken";

export const createAccessToken = ({ userId, email, secret, expiresIn }) => {
  return jwt.sign(
    {
      sub: userId,
      email,
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
