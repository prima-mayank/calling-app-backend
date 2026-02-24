import bcrypt from "bcryptjs";
import AuthConfig from "../../../config/authConfig.js";
import { AuthServiceError } from "../AuthServiceError.js";
import User from "../models/User.js";

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

const normalizeDisplayName = (value) => {
  const displayName = String(value || "").trim();
  return displayName.slice(0, 64);
};

const validateSignupPayload = ({ email, password, displayName }) => {
  if (!String(email || "").trim()) {
    throw new AuthServiceError("Email is required.", {
      status: 400,
      code: "email-required",
    });
  }

  if (!String(password || "").length) {
    throw new AuthServiceError("Password is required.", {
      status: 400,
      code: "password-required",
    });
  }

  if (!displayName) {
    throw new AuthServiceError("Display name is required.", {
      status: 400,
      code: "display-name-required",
    });
  }

  if (!AuthConfig.AUTH_RELAXED_VALIDATION && displayName.length < 2) {
    throw new AuthServiceError("Display name must be at least 2 characters.", {
      status: 400,
      code: "display-name-too-short",
    });
  }
};

export const createUserWithPassword = async ({ email, password, displayName }) => {
  const normalizedEmail = normalizeEmail(email);
  const normalizedDisplayName = normalizeDisplayName(displayName);
  validateSignupPayload({
    email: normalizedEmail,
    password: String(password || ""),
    displayName: normalizedDisplayName,
  });

  const existingUser = await User.findOne({ email: normalizedEmail }).select("_id").lean();
  if (existingUser?._id) {
    throw new AuthServiceError("Email is already registered.", {
      status: 409,
      code: "email-in-use",
    });
  }

  const passwordHash = await bcrypt.hash(String(password), AuthConfig.AUTH_BCRYPT_ROUNDS);
  const user = await User.create({
    email: normalizedEmail,
    displayName: normalizedDisplayName,
    passwordHash,
  });

  return user.toPublicJSON();
};

export const loginUserWithPassword = async ({ email, password }) => {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = String(password || "");
  if (!normalizedEmail || !normalizedPassword) {
    throw new AuthServiceError("Invalid email or password.", {
      status: 401,
      code: "invalid-credentials",
    });
  }

  const user = await User.findOne({ email: normalizedEmail }).select("+passwordHash");
  if (!user?.passwordHash) {
    throw new AuthServiceError("Invalid email or password.", {
      status: 401,
      code: "invalid-credentials",
    });
  }

  const isPasswordValid = await bcrypt.compare(normalizedPassword, user.passwordHash);
  if (!isPasswordValid) {
    throw new AuthServiceError("Invalid email or password.", {
      status: 401,
      code: "invalid-credentials",
    });
  }

  return user.toPublicJSON();
};

export const getPublicUserById = async (userId) => {
  if (!userId) return null;
  const user = await User.findById(userId);
  if (!user) return null;
  return user.toPublicJSON();
};
