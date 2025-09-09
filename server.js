const express = require("express");
const cors = require("cors");
const { Resend } = require("resend");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Middleware
app.use(
  cors({
    origin:
      process.env.NODE_ENV === "production"
        ? ["https://yourdomain.com"]
        : ["http://localhost:8080", "http://localhost:5173"],
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Validation middleware
const validateContactForm = (req, res, next) => {
  const { name, email, subject, message } = req.body;

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

// Contact form endpoint
app.post("/api/contact", validateContactForm, async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    // Send email using Resend
    const { data, error } = await resend.emails.send({
      from: "Contact Form <onboarding@aihridoy.com>",
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
                <td style="padding: 10px 0; border-bottom: 1px solid #dee2e6; color: #6c757d;">${name}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #dee2e6; font-weight: bold; color: #495057;">Email:</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #dee2e6; color: #6c757d;">${email}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #dee2e6; font-weight: bold; color: #495057;">Subject:</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #dee2e6; color: #6c757d;">${subject}</td>
              </tr>
            </table>
          </div>
          
          <div style="background: #f8f9fa; padding: 25px; border-radius: 8px;">
            <h3 style="color: #333; margin-top: 0;">Message</h3>
            <div style="background: white; padding: 20px; border-radius: 6px; border-left: 4px solid #667eea;">
              <p style="margin: 0; line-height: 1.6; color: #495057;">${message.replace(
                /\n/g,
                "<br>"
              )}</p>
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
});

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
