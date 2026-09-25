@echo off
echo ============================================
echo REVEX - Vercel Deployment Helper
echo ============================================
echo.

echo [1/5] Checking Git installation...
git --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Git is not installed. Please install Git from https://git-scm.com/
    pause
    exit /b 1
)
echo Git OK

echo.
echo [2/5] Checking Node.js installation...
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed. Please install Node.js 18+ from https://nodejs.org/
    pause
    exit /b 1
)
echo Node.js OK

echo.
echo [3/5] Installing dependencies...
npm install
if errorlevel 1 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)
echo Dependencies installed

echo.
echo [4/5] Checking for .env file...
if not exist .env (
    echo WARNING: .env file not found. Copying from .env.example...
    copy .env.example .env
    echo.
    echo IMPORTANT: Edit .env file with your MongoDB URI and JWT secret!
    echo.
) else (
    echo .env file exists
)

echo.
echo [5/5] Initializing Git repository...
if not exist .git (
    git init
    git add .
    git commit -m "Initial commit: REVEX app ready for Vercel deployment"
    echo.
    echo Git repository initialized.
    echo.
    echo NEXT STEPS:
    echo 1. Create a GitHub repository at https://github.com/new
    echo 2. Run: git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
    echo 3. Run: git branch -M main
    echo 4. Run: git push -u origin main
    echo 4. Deploy on Vercel: https://vercel.com/dashboard
) else (
    echo Git repository already exists
    echo.
    echo To push updates:
    echo git add .
    echo git commit -m "Your commit message"
    echo git push
)

echo.
echo ============================================
echo Setup Complete!
echo ============================================
echo.
echo IMPORTANT: Before deploying to Vercel:
echo 1. Set up MongoDB Atlas (free at mongodb.com/atlas)
echo 2. Get your connection string
echo 3. Generate JWT secret: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
echo 4. Add these as Environment Variables in Vercel dashboard (use your own secrets)
echo 5. Set ADMIN_PASSWORD only for the first admin bootstrap; never commit .env
echo.
pause