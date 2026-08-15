import cv2
import numpy as np
from pathlib import Path

def remove_background(input_path):
    # Load the image
    img = cv2.imread(str(input_path))

    # Define lower and upper bounds for the orange colors
    # Adjust these values based on your specific shade of orange
    lower_orange = np.array([0, 50, 50])
    upper_orange = np.array([30, 255, 255])

    # Convert BGR to HSV color space
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    # Threshold the HSV image to get only orange colors
    mask = cv2.inRange(hsv, lower_orange, upper_orange)
    result = img.copy()

    # Replace orange pixels with white (or any other background color you prefer)
    result[mask > 0] = [255, 255, 255]

    return result

if __name__ == "__main__":
    input_file = Path("/Users/ummi/.hii/workspace/assets/desktop-8d4c0274-dad8-4cea-a25f-532e159d41bb-33748759-2c95-4a89-acaa-b42c2933c416.jpg")
    if not input_file.exists():
        print(f"Error: File {input_file} does not exist.")
    else:
        output_img = remove_background(input_file)
        output_path = input_file.with_name('output_' + input_file.name)
        cv2.imwrite(str(output_path), output_img)
        print(f"Background removed. Saved to {output_path}")