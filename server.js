const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { Resend } = require("resend");
require("dotenv").config();

const { createAuthRouter, requireEnvironment } = require("./auth");
const { createPostsRouter } = require("./posts");
const { triggerBuild } = require("./build-hook");

const app = express();
const PORT = process.env.PORT || 5000;

// Behind Render/Netlify the client IP arrives in X-Forwarded-For; without this
// the rate limiter would bucket every visitor under the proxy's address.
app.set("trust proxy", 1);

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Middleware
app.use(
  cors({
    origin:
      process.env.NODE_ENV === "production"
        ? ["https://ashrafulislam.im", "https://getash.netlify.app"]
        : ["http://localhost:8080", "http://localhost:5173"],
    credentials: true,
  }),
);
// A post's body is prose and can run long; the 16kb ceiling that suits a
// contact form would reject a real article. Still bounded, so an unauthorised
// caller cannot make the process chew on megabytes before auth runs.
app.use(express.json({ limit: "512kb" }));
app.use(express.urlencoded({ extended: true, limit: "16kb" }));
app.use(cookieParser());

/**
 * This endpoint is unauthenticated and spends money on every call: each request
 * sends a real email through a paid Resend account and against this domain's
 * sending reputation. Without a limit, a trivial loop drains the quota, floods
 * the inbox and gets the domain flagged — at which point the form is silently
 * broken for the people it exists to serve. CORS does not help here; it is
 * enforced by browsers and ignored by anything scripted.
 */
const tooManyRequests = {
  success: false,
  message:
    "Too many messages sent from this address. Please try again later, or email me directly at aihridoy976@gmail.com.",
};

// Broad ceiling on raw traffic, including malformed payloads that never reach
// Resend. Generous enough that no real person will meet it.
const floodLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: tooManyRequests,
});

// Strict ceiling on messages that actually send. skipFailedRequests means a
// rejected submission does not consume the quota — otherwise someone who
// mistypes their email twice would be locked out before sending anything.
const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5,
  skipFailedRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: tooManyRequests,
});

/** Escape HTML so submitted text cannot inject markup into the email body. */
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );

// Validation middleware. Mirrored client-side in devash/src/lib/contact-validation.ts
// — when these rules drift, the form accepts input this endpoint then rejects.
const validateContactForm = (req, res, next) => {
  const { name, email, subject, message, honeypot } = req.body;

  // Hidden field that only automated clients fill in. Report success so the
  // sender has no signal to retry with a different shape.
  if (honeypot) {
    return res.status(200).json({
      success: true,
      message: "Message sent successfully!",
    });
  }

  // Check if all fields are provided
  if (!name || !email || !subject || !message) {
    return res.status(400).json({
      success: false,
      message: "All fields are required",
    });
  }

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({
      success: false,
      message: "Please provide a valid email address",
    });
  }

  // Check field lengths
  if (name.trim().length < 2) {
    return res.status(400).json({
      success: false,
      message: "Name must be at least 2 characters long",
    });
  }

  if (subject.trim().length < 5) {
    return res.status(400).json({
      success: false,
      message: "Subject must be at least 5 characters long",
    });
  }

  if (message.trim().length < 10) {
    return res.status(400).json({
      success: false,
      message: "Message must be at least 10 characters long",
    });
  }

  next();
};

/**
 * Contract mirrors devash/src/types/api.ts (ContactFormData -> ContactFormResponse). Keep both in sync.
 * @param {{ name: string, email: string, subject: string, message: string }} req.body
 * @returns {{ success: boolean, message: string, emailId?: string }}
 */
app.post(
  "/api/contact",
  floodLimiter,
  validateContactForm,
  sendLimiter,
  async (req, res) => {
    try {
      const { name, email, subject, message } = req.body;

      // Everything interpolated into the HTML body below is attacker-controlled.
      const safe = {
        name: escapeHtml(name),
        email: escapeHtml(email),
        subject: escapeHtml(subject),
        message: escapeHtml(message).replace(/\n/g, "<br>"),
      };

      // Send email using Resend
      const { data, error } = await resend.emails.send({
        from: "Contact Form <onboarding@ashrafulislam.im>",
        replyTo: email,
        to: [process.env.RECIPIENT_EMAIL],
        subject: `Contact Form: ${subject}`,
        html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px; margin-bottom: 20px;">
            <h1 style="color: white; margin: 0; text-align: center;">New Contact Form Submission</h1>
          </div>
          
          <div style="background: #f8f9fa; padding: 25px; border-radius: 8px; margin-bottom: 20px;">
            <h2 style="color: #333; margin-top: 0;">Contact Details</h2>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #dee2e6; font-weight: bold; color: #495057;">Name:</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #dee2e6; color: #6c757d;">${safe.name}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #dee2e6; font-weight: bold; color: #495057;">Email:</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #dee2e6; color: #6c757d;">${safe.email}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #dee2e6; font-weight: bold; color: #495057;">Subject:</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #dee2e6; color: #6c757d;">${safe.subject}</td>
              </tr>
            </table>
          </div>
          
          <div style="background: #f8f9fa; padding: 25px; border-radius: 8px;">
            <h3 style="color: #333; margin-top: 0;">Message</h3>
            <div style="background: white; padding: 20px; border-radius: 6px; border-left: 4px solid #667eea;">
              <p style="margin: 0; line-height: 1.6; color: #495057;">${safe.message}</p>
            </div>
          </div>
          
          <div style="margin-top: 20px; text-align: center; color: #6c757d; font-size: 14px;">
            <p>This email was sent from your portfolio contact form.</p>
            <p>Sent on ${new Date().toLocaleString()}</p>
          </div>
        </div>
      `,
        text: `
New Contact Form Submission

Name: ${name}
Email: ${email}
Subject: ${subject}

Message:
${message}

Sent on ${new Date().toLocaleString()}
      `,
      });

      if (error) {
        console.error("Resend error:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to send email. Please try again later.",
        });
      }

      console.log("Email sent successfully:", data);

      res.status(200).json({
        success: true,
        message: "Message sent successfully!",
        emailId: data.id,
      });
    } catch (error) {
      console.error("Server error:", error);
      res.status(500).json({
        success: false,
        message: "Server error. Please try again later.",
      });
    }
  },
);

/**
 * Admin and posts.
 *
 * Mounted only when the admin credentials are configured. A half-configured
 * deploy that served /api/auth/login with no hash to compare against would be
 * worse than one that serves no admin at all — the contact form, which is what
 * this service exists for, keeps working either way.
 */
try {
  requireEnvironment();

  app.use("/api/auth", createAuthRouter());
  app.use("/api/posts", createPostsRouter({ onPublish: triggerBuild }));

  console.log("Admin auth and posts API mounted.");
} catch (error) {
  console.warn(`Admin routes not mounted: ${error.message}`);
}

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Server is running!",
    timestamp: new Date().toISOString(),
  });
});

// 404 handler - FIXED VERSION
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
