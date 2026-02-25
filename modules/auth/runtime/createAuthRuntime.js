import AuthConfig from "../../../config/authConfig.js";
import { createAccessToken } from "../utils/tokenUtils.js";
import {
  createUserWithPassword,
  getPublicUserById,
  loginUserWithPassword,
} from "../services/authService.js";

export const createAuthRuntime = ({ dbState }) => {
  const authEnabled = AuthConfig.AUTH_ENABLED;
  const hasJwtSecret = !!AuthConfig.AUTH_JWT_SECRET;
  const dbConnected = !!dbState?.connected;

  let disableReason = "";
  if (!authEnabled) disableReason = "auth-disabled";
  else if (!dbConnected) disableReason = "db-unavailable";
  else if (!hasJwtSecret) disableReason = "jwt-secret-missing";

  const enabled = !disableReason;

  const issueAccessToken = (user) =>
    createAccessToken({
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      secret: AuthConfig.AUTH_JWT_SECRET,
      expiresIn: AuthConfig.AUTH_JWT_EXPIRES_IN,
    });

  return {
    enabled,
    disableReason,
    jwtSecret: AuthConfig.AUTH_JWT_SECRET,
    async signup(payload) {
      const user = await createUserWithPassword(payload);
      const token = issueAccessToken(user);
      return { user, token };
    },
    async login(payload) {
      const user = await loginUserWithPassword(payload);
      const token = issueAccessToken(user);
      return { user, token };
    },
    async getUserById(userId) {
      return getPublicUserById(userId);
    },
  };
};
